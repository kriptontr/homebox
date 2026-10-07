package printrelay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeHost struct {
	mu   sync.Mutex
	msgs chan []byte
	fail bool
}

func newFakeHost() *fakeHost {
	return &fakeHost{msgs: make(chan []byte, 16)}
}

func (f *fakeHost) Write(msg []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return errors.New("closed")
	}
	f.msgs <- msg
	return nil
}

func (f *fakeHost) next(t *testing.T) map[string]any {
	t.Helper()
	select {
	case m := <-f.msgs:
		out := map[string]any{}
		require.NoError(t, json.Unmarshal(m, &out))
		return out
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for host message")
		return nil
	}
}

func registerHost(t *testing.T, hub *Hub, gid uuid.UUID, name string) (*fakeHost, uuid.UUID) {
	t.Helper()
	host := newFakeHost()
	hub.Connect(host, HostInfo{GID: gid, UserName: "alice"})
	require.NoError(t, hub.HandleMessage(host, []byte(`{"type":"register","name":"`+name+`"}`)))
	msg := host.next(t)
	require.Equal(t, "registered", msg["type"])
	id, err := uuid.Parse(msg["printerId"].(string))
	require.NoError(t, err)
	return host, id
}

func labelJob() PrintJob {
	return PrintJob{Kind: "label", LabelType: "item", ID: uuid.NewString()}
}

func submitAsync(hub *Hub, ctx context.Context, gid, pid uuid.UUID, job PrintJob) <-chan error {
	ch := make(chan error, 1)
	go func() { ch <- hub.Submit(ctx, gid, pid, job) }()
	return ch
}

func waitErr(t *testing.T, ch <-chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for Submit")
		return nil
	}
}

func TestRegister(t *testing.T) {
	hub := NewHub(time.Second)
	gid := uuid.New()
	host, id := registerHost(t, hub, gid, "MX10")

	list := hub.List(gid)
	require.Len(t, list, 1)
	assert.Equal(t, id, list[0].ID)
	assert.Equal(t, "MX10", list[0].Name)
	assert.Equal(t, "alice", list[0].SharedBy)
	assert.False(t, list[0].ConnectedAt.IsZero())

	// re-register renames, keeps id
	require.NoError(t, hub.HandleMessage(host, []byte(`{"type":"register","name":"GB02"}`)))
	msg := host.next(t)
	assert.Equal(t, id.String(), msg["printerId"])
	list = hub.List(gid)
	require.Len(t, list, 1)
	assert.Equal(t, "GB02", list[0].Name)

	// unregister keeps connection but removes printer
	require.NoError(t, hub.HandleMessage(host, []byte(`{"type":"unregister"}`)))
	assert.Empty(t, hub.List(gid))

	// register without Connect fails
	_, err := hub.Register(newFakeHost(), "x")
	assert.Error(t, err)
}

func TestListGroupIsolation(t *testing.T) {
	hub := NewHub(time.Second)
	g1, g2 := uuid.New(), uuid.New()
	_, p1 := registerHost(t, hub, g1, "one")
	_, p2 := registerHost(t, hub, g2, "two")

	l1 := hub.List(g1)
	require.Len(t, l1, 1)
	assert.Equal(t, p1, l1[0].ID)

	l2 := hub.List(g2)
	require.Len(t, l2, 1)
	assert.Equal(t, p2, l2[0].ID)

	assert.Empty(t, hub.List(uuid.New()))

	// other group's printer is not found
	err := hub.Submit(context.Background(), g1, p2, labelJob())
	assert.ErrorIs(t, err, ErrPrinterNotFound)
	err = hub.Submit(context.Background(), g1, uuid.New(), labelJob())
	assert.ErrorIs(t, err, ErrPrinterNotFound)
}

func TestJobRoundTrip(t *testing.T) {
	hub := NewHub(2 * time.Second)
	gid := uuid.New()
	host, pid := registerHost(t, hub, gid, "p")

	job := labelJob()
	done := submitAsync(hub, context.Background(), gid, pid, job)

	msg := host.next(t)
	assert.Equal(t, "job", msg["type"])
	j := msg["job"].(map[string]any)
	assert.Equal(t, "label", j["kind"])
	assert.Equal(t, "item", j["labelType"])
	assert.Equal(t, job.ID, j["id"])
	jobID := msg["jobId"].(string)

	// result from another host is ignored
	other, _ := registerHost(t, hub, gid, "other")
	require.NoError(t, hub.HandleMessage(other, []byte(`{"type":"result","jobId":"`+jobID+`","ok":true}`)))

	require.NoError(t, hub.HandleMessage(host, []byte(`{"type":"result","jobId":"`+jobID+`","ok":true}`)))
	assert.NoError(t, waitErr(t, done))

	// failure result
	done = submitAsync(hub, context.Background(), gid, pid, labelJob())
	msg = host.next(t)
	jobID = msg["jobId"].(string)
	require.NoError(t, hub.HandleMessage(host, []byte(`{"type":"result","jobId":"`+jobID+`","ok":false,"error":"out of paper"}`)))
	err := waitErr(t, done)
	var he *HostError
	require.ErrorAs(t, err, &he)
	assert.Equal(t, "out of paper", he.Msg)
}

func TestJobTimeout(t *testing.T) {
	hub := NewHub(50 * time.Millisecond)
	gid := uuid.New()
	host, pid := registerHost(t, hub, gid, "p")

	err := hub.Submit(context.Background(), gid, pid, labelJob())
	assert.ErrorIs(t, err, ErrTimeout)
	host.next(t) // job was delivered

	hub.mu.Lock()
	assert.Empty(t, hub.pending)
	hub.mu.Unlock()
}

func TestContextCancel(t *testing.T) {
	hub := NewHub(time.Minute)
	gid := uuid.New()
	_, pid := registerHost(t, hub, gid, "p")

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err := hub.Submit(ctx, gid, pid, labelJob())
	assert.ErrorIs(t, err, context.DeadlineExceeded)
}

func TestHostDisconnectMidJob(t *testing.T) {
	hub := NewHub(time.Minute)
	gid := uuid.New()
	host, pid := registerHost(t, hub, gid, "p")

	done := submitAsync(hub, context.Background(), gid, pid, labelJob())
	host.next(t)
	hub.Disconnect(host)

	err := waitErr(t, done)
	var he *HostError
	require.ErrorAs(t, err, &he)
	assert.Empty(t, hub.List(gid))
	assert.ErrorIs(t, hub.Submit(context.Background(), gid, pid, labelJob()), ErrPrinterNotFound)

	// unregister mid-job also fails the job
	host2, pid2 := registerHost(t, hub, gid, "p2")
	done = submitAsync(hub, context.Background(), gid, pid2, labelJob())
	host2.next(t)
	hub.Unregister(host2)
	require.ErrorAs(t, waitErr(t, done), &he)
}

func TestHostWriteFailure(t *testing.T) {
	hub := NewHub(time.Minute)
	gid := uuid.New()
	host, pid := registerHost(t, hub, gid, "p")
	host.fail = true

	err := hub.Submit(context.Background(), gid, pid, labelJob())
	var he *HostError
	require.ErrorAs(t, err, &he)
}

func TestJobValidation(t *testing.T) {
	b64 := func(n int) string { return base64.StdEncoding.EncodeToString(make([]byte, n)) }

	valid := []PrintJob{
		{Kind: "label", LabelType: "item", ID: uuid.NewString()},
		{Kind: "label", LabelType: "location", ID: uuid.NewString()},
		{Kind: "label", LabelType: "asset", ID: uuid.NewString()},
		{Kind: "bitmap", Width: 384, Height: 8, Data: b64(384)},
		{Kind: "bitmap", Width: 8, Height: 1, Data: b64(1)},
		{Kind: "bitmap", Width: 16, Height: 3, Data: b64(6)},
	}
	for _, j := range valid {
		_, err := j.Normalize()
		assert.NoError(t, err, "%+v", j)
	}

	invalid := []PrintJob{
		{},
		{Kind: "pdf"},
		{Kind: "label", LabelType: "box", ID: uuid.NewString()},
		{Kind: "label", LabelType: "item", ID: "nope"},
		{Kind: "label", LabelType: "item", ID: uuid.Nil.String()},
		{Kind: "bitmap", Width: 0, Height: 8, Data: b64(0)},
		{Kind: "bitmap", Width: 12, Height: 8, Data: b64(12)},
		{Kind: "bitmap", Width: 392, Height: 8, Data: b64(392)},
		{Kind: "bitmap", Width: 384, Height: 0, Data: ""},
		{Kind: "bitmap", Width: 8, Height: 4001, Data: b64(4001)},
		{Kind: "bitmap", Width: 384, Height: 8, Data: b64(383)},
		{Kind: "bitmap", Width: 384, Height: 8, Data: "!!!not base64"},
	}
	for _, j := range invalid {
		_, err := j.Normalize()
		assert.ErrorIs(t, err, ErrInvalidJob, "%+v", j)
	}

	// Submit validates before lookup
	hub := NewHub(time.Second)
	err := hub.Submit(context.Background(), uuid.New(), uuid.New(), PrintJob{Kind: "x"})
	assert.ErrorIs(t, err, ErrInvalidJob)

	// Normalize strips irrelevant fields
	n, err := PrintJob{Kind: "label", LabelType: "item", ID: uuid.NewString(), Width: 8, Data: "x"}.Normalize()
	require.NoError(t, err)
	assert.Zero(t, n.Width)
	assert.Empty(t, n.Data)
}

func TestHandleMessageErrors(t *testing.T) {
	hub := NewHub(time.Second)
	host := newFakeHost()
	hub.Connect(host, HostInfo{GID: uuid.New()})
	assert.Error(t, hub.HandleMessage(host, []byte(`not json`)))
	assert.Error(t, hub.HandleMessage(host, []byte(`{"type":"wat"}`)))
	assert.Error(t, hub.HandleMessage(host, []byte(`{"type":"result","jobId":"bad"}`)))
	// unknown job id is silently ignored
	assert.NoError(t, hub.HandleMessage(host, []byte(`{"type":"result","jobId":"`+uuid.NewString()+`","ok":true}`)))
}

func TestPingAll(t *testing.T) {
	hub := NewHub(time.Second)
	host := newFakeHost()
	hub.Connect(host, HostInfo{GID: uuid.New()})
	hub.PingAll()
	assert.Equal(t, "ping", host.next(t)["type"])
}
