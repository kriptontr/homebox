// Package printrelay relays print jobs from any client in a group to a printer
// that is physically connected (e.g. over Web Bluetooth) to another client's
// browser. The browser holding the printer (the "host") keeps a websocket open
// to the server; the Hub forwards jobs to it and waits for the host's result.
package printrelay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// DefaultJobTimeout is how long Submit waits for a host to report a result.
const DefaultJobTimeout = 60 * time.Second

const (
	maxBitmapWidth  = 384
	maxBitmapHeight = 4000
	maxNameLength   = 128
)

var (
	// ErrInvalidJob is returned (wrapped) when a PrintJob fails validation.
	ErrInvalidJob = errors.New("invalid print job")
	// ErrPrinterNotFound is returned when the printer does not exist or belongs to another group.
	ErrPrinterNotFound = errors.New("printer not found")
	// ErrTimeout is returned when the host does not report a result in time.
	ErrTimeout = errors.New("timed out waiting for printer")
)

// HostError is returned when the host reports a failure, disconnects
// mid-job, or cannot be reached.
type HostError struct {
	Msg string
}

func (e *HostError) Error() string { return e.Msg }

// Host is the connection to a browser holding a printer. *melody.Session
// satisfies this interface. Implementations must be comparable (pointers).
type Host interface {
	Write(msg []byte) error
}

// HostInfo describes the authenticated user behind a host connection.
type HostInfo struct {
	GID      uuid.UUID
	UserName string
}

// PrintJob is a job sent to a host printer.
type PrintJob struct {
	Kind string `json:"kind"`

	// kind == "label"
	LabelType string `json:"labelType,omitempty"`
	ID        string `json:"id,omitempty"`

	// kind == "bitmap": 1 bit/pixel, LSB-first, 1 = black, packed over the
	// whole pixel array, base64 encoded.
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
	Data   string `json:"data,omitempty"`
}

// Normalize validates the job and returns a copy containing only the fields
// relevant to its kind.
func (j PrintJob) Normalize() (PrintJob, error) {
	invalid := func(format string, args ...any) error {
		return fmt.Errorf("%w: %s", ErrInvalidJob, fmt.Sprintf(format, args...))
	}

	switch j.Kind {
	case "label":
		switch j.LabelType {
		case "item", "location", "asset":
		default:
			return PrintJob{}, invalid("labelType must be one of item, location, asset")
		}
		id, err := uuid.Parse(j.ID)
		if err != nil || id == uuid.Nil {
			return PrintJob{}, invalid("id must be a valid uuid")
		}
		return PrintJob{Kind: j.Kind, LabelType: j.LabelType, ID: id.String()}, nil

	case "bitmap":
		if j.Width < 8 || j.Width > maxBitmapWidth || j.Width%8 != 0 {
			return PrintJob{}, invalid("width must be a multiple of 8 between 8 and %d", maxBitmapWidth)
		}
		if j.Height < 1 || j.Height > maxBitmapHeight {
			return PrintJob{}, invalid("height must be between 1 and %d", maxBitmapHeight)
		}
		data, err := base64.StdEncoding.DecodeString(j.Data)
		if err != nil {
			return PrintJob{}, invalid("data must be valid base64")
		}
		if want := j.Width * j.Height / 8; len(data) != want {
			return PrintJob{}, invalid("data must decode to %d bytes, got %d", want, len(data))
		}
		return PrintJob{Kind: j.Kind, Width: j.Width, Height: j.Height, Data: j.Data}, nil

	default:
		return PrintJob{}, invalid("kind must be label or bitmap")
	}
}

// PrinterInfo is the public description of a shared printer.
type PrinterInfo struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	SharedBy    string    `json:"sharedBy"`
	ConnectedAt time.Time `json:"connectedAt"`
}

type printer struct {
	PrinterInfo
	gid  uuid.UUID
	host Host
}

type jobResult struct {
	ok  bool
	err string
}

type pendingJob struct {
	printerID uuid.UUID
	result    chan jobResult // buffered(1); written at most once (under Hub.mu)
}

// Hub is an in-memory registry of shared printers and in-flight jobs.
type Hub struct {
	mu        sync.Mutex
	hosts     map[Host]HostInfo
	byHost    map[Host]*printer
	printers  map[uuid.UUID]*printer
	pending   map[uuid.UUID]*pendingJob
	timeout   time.Duration
	nowFn     func() time.Time
	newIDFunc func() uuid.UUID
}

// NewHub creates a Hub. A timeout <= 0 uses DefaultJobTimeout.
func NewHub(timeout time.Duration) *Hub {
	if timeout <= 0 {
		timeout = DefaultJobTimeout
	}
	return &Hub{
		hosts:     map[Host]HostInfo{},
		byHost:    map[Host]*printer{},
		printers:  map[uuid.UUID]*printer{},
		pending:   map[uuid.UUID]*pendingJob{},
		timeout:   timeout,
		nowFn:     time.Now,
		newIDFunc: uuid.New,
	}
}

// Timeout returns how long Submit waits for a host result.
func (h *Hub) Timeout() time.Duration { return h.timeout }

// Connect records a new host connection. It does not share a printer until
// the host sends a register message.
func (h *Hub) Connect(host Host, info HostInfo) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.hosts[host] = info
}

// Disconnect removes the host and its printer, failing any pending jobs.
func (h *Hub) Disconnect(host Host) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removePrinterLocked(host, "printer host disconnected")
	delete(h.hosts, host)
}

// Register shares (or renames) the host's printer and returns its ID.
func (h *Hub) Register(host Host, name string) (uuid.UUID, error) {
	if r := []rune(name); len(r) > maxNameLength {
		name = string(r[:maxNameLength])
	}
	if name == "" {
		name = "Printer"
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	info, ok := h.hosts[host]
	if !ok {
		return uuid.Nil, errors.New("host not connected")
	}

	if p, ok := h.byHost[host]; ok {
		p.Name = name
		return p.ID, nil
	}

	p := &printer{
		PrinterInfo: PrinterInfo{
			ID:          h.newIDFunc(),
			Name:        name,
			SharedBy:    info.UserName,
			ConnectedAt: h.nowFn(),
		},
		gid:  info.GID,
		host: host,
	}
	h.byHost[host] = p
	h.printers[p.ID] = p
	return p.ID, nil
}

// Unregister stops sharing the host's printer, keeping the connection.
func (h *Hub) Unregister(host Host) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removePrinterLocked(host, "printer was unshared")
}

func (h *Hub) removePrinterLocked(host Host, reason string) {
	p, ok := h.byHost[host]
	if !ok {
		return
	}
	delete(h.byHost, host)
	delete(h.printers, p.ID)

	for id, job := range h.pending {
		if job.printerID == p.ID {
			job.result <- jobResult{ok: false, err: reason}
			delete(h.pending, id)
		}
	}
}

// List returns the printers shared within the given group, oldest first.
func (h *Hub) List(gid uuid.UUID) []PrinterInfo {
	h.mu.Lock()
	defer h.mu.Unlock()

	out := []PrinterInfo{}
	for _, p := range h.printers {
		if p.gid == gid {
			out = append(out, p.PrinterInfo)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ConnectedAt.Before(out[j].ConnectedAt)
	})
	return out
}

// Submit validates the job, forwards it to the printer's host and waits for
// the result, the timeout, or ctx cancellation.
//
// Errors: wrapped ErrInvalidJob, ErrPrinterNotFound, ErrTimeout, *HostError,
// or ctx.Err().
func (h *Hub) Submit(ctx context.Context, gid, printerID uuid.UUID, job PrintJob) error {
	job, err := job.Normalize()
	if err != nil {
		return err
	}

	jobID := uuid.New()
	msg, err := json.Marshal(jobMsg{Type: "job", JobID: jobID, Job: job})
	if err != nil {
		return err
	}

	h.mu.Lock()
	p, ok := h.printers[printerID]
	if !ok || p.gid != gid {
		h.mu.Unlock()
		return ErrPrinterNotFound
	}
	pj := &pendingJob{printerID: printerID, result: make(chan jobResult, 1)}
	h.pending[jobID] = pj
	host := p.host
	h.mu.Unlock()

	if err := host.Write(msg); err != nil {
		h.dropPending(jobID)
		return &HostError{Msg: "failed to send job to printer host"}
	}

	timer := time.NewTimer(h.timeout)
	defer timer.Stop()

	select {
	case res := <-pj.result:
		if res.ok {
			return nil
		}
		if res.err == "" {
			res.err = "print failed"
		}
		return &HostError{Msg: res.err}
	case <-timer.C:
		h.dropPending(jobID)
		return ErrTimeout
	case <-ctx.Done():
		h.dropPending(jobID)
		return ctx.Err()
	}
}

func (h *Hub) dropPending(jobID uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.pending, jobID)
}

// PingAll sends a ping message to every connected host.
func (h *Hub) PingAll() {
	h.mu.Lock()
	hosts := make([]Host, 0, len(h.hosts))
	for host := range h.hosts {
		hosts = append(hosts, host)
	}
	h.mu.Unlock()

	for _, host := range hosts {
		_ = host.Write(pingMsg)
	}
}

var pingMsg = []byte(`{"type":"ping"}`)

type jobMsg struct {
	Type  string    `json:"type"`
	JobID uuid.UUID `json:"jobId"`
	Job   PrintJob  `json:"job"`
}

type registeredMsg struct {
	Type      string    `json:"type"`
	PrinterID uuid.UUID `json:"printerId"`
}

type hostMsg struct {
	Type  string `json:"type"`
	Name  string `json:"name"`
	JobID string `json:"jobId"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// HandleMessage processes a message received from a host.
func (h *Hub) HandleMessage(host Host, data []byte) error {
	var msg hostMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		return fmt.Errorf("invalid message: %w", err)
	}

	switch msg.Type {
	case "register":
		id, err := h.Register(host, msg.Name)
		if err != nil {
			return err
		}
		out, err := json.Marshal(registeredMsg{Type: "registered", PrinterID: id})
		if err != nil {
			return err
		}
		return host.Write(out)
	case "unregister":
		h.Unregister(host)
		return nil
	case "result":
		jobID, err := uuid.Parse(msg.JobID)
		if err != nil {
			return fmt.Errorf("invalid jobId: %w", err)
		}
		h.resolve(host, jobID, jobResult{ok: msg.OK, err: msg.Error})
		return nil
	default:
		return fmt.Errorf("unknown message type %q", msg.Type)
	}
}

// resolve delivers a result, but only if it comes from the host that owns
// the job's printer.
func (h *Hub) resolve(host Host, jobID uuid.UUID, res jobResult) {
	h.mu.Lock()
	defer h.mu.Unlock()

	job, ok := h.pending[jobID]
	if !ok {
		return
	}
	p, ok := h.byHost[host]
	if !ok || p.ID != job.printerID {
		return
	}
	job.result <- res
	delete(h.pending, jobID)
}
