package v1

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/hay-kot/httpkit/errchain"
	"github.com/hay-kot/httpkit/server"
	"github.com/olahol/melody"
	"github.com/rs/zerolog/log"
	"github.com/sysadminsmedia/homebox/backend/internal/core/services"
	"github.com/sysadminsmedia/homebox/backend/internal/core/services/printrelay"
	"github.com/sysadminsmedia/homebox/backend/internal/sys/validate"
	"github.com/sysadminsmedia/homebox/backend/internal/web/adapters"
)

const (
	printerWSMaxMessageSize = 64 << 10 // host messages are small JSON control messages
	printJobMaxBodySize     = 1 << 20
	printerPingInterval     = 10 * time.Second
)

// PrintResult is the response of a successful relayed print job.
type PrintResult struct {
	OK bool `json:"ok"`
}

// HandlePrintersWS godoc
//
//	@Summary		Shared printer host websocket
//	@Description	Websocket used by a browser holding a Bluetooth printer to share it with its group.
//	@Description	Host messages: {"type":"register","name":"..."}, {"type":"unregister"}, {"type":"result","jobId":"...","ok":true,"error":"..."}.
//	@Description	Server messages: {"type":"registered","printerId":"..."}, {"type":"job","jobId":"...","job":{...}}, {"type":"ping"}.
//	@Tags			Printers
//	@Success		101
//	@Router			/v1/ws/printers [GET]
//	@Security		Bearer
func (ctrl *V1Controller) HandlePrintersWS() errchain.HandlerFunc {
	hub := ctrl.printRelay

	m := melody.New()
	m.Config.MaxMessageSize = printerWSMaxMessageSize

	m.HandleConnect(func(s *melody.Session) {
		auth := services.NewContext(s.Request.Context())
		info := printrelay.HostInfo{GID: auth.GID}
		if auth.User != nil {
			info.UserName = auth.User.Name
		}
		hub.Connect(s, info)
	})

	m.HandleDisconnect(func(s *melody.Session) {
		hub.Disconnect(s)
	})

	m.HandleMessage(func(s *melody.Session, msg []byte) {
		if err := hub.HandleMessage(s, msg); err != nil {
			log.Debug().Err(err).Msg("print relay: bad host message")
		}
	})

	go func() {
		ping := time.NewTicker(printerPingInterval)
		defer ping.Stop()
		for range ping.C {
			hub.PingAll()
		}
	}()

	return func(w http.ResponseWriter, r *http.Request) error {
		return m.HandleRequest(w, r)
	}
}

// HandlePrintersGetAll godoc
//
//	@Summary	Get Shared Printers
//	@Tags		Printers
//	@Produce	json
//	@Success	200	{object}	[]printrelay.PrinterInfo
//	@Router		/v1/printers [GET]
//	@Security	Bearer
func (ctrl *V1Controller) HandlePrintersGetAll() errchain.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		auth := services.NewContext(r.Context())
		return server.JSON(w, http.StatusOK, ctrl.printRelay.List(auth.GID))
	}
}

// HandlePrinterPrint godoc
//
//	@Summary		Print on Shared Printer
//	@Description	Relays a print job to the browser hosting the printer and waits (up to 60s) for its result.
//	@Tags			Printers
//	@Accept			json
//	@Produce		json
//	@Param			id		path		string				true	"Printer ID"
//	@Param			payload	body		printrelay.PrintJob	true	"Print Job"
//	@Success		200		{object}	PrintResult
//	@Failure		400		{object}	validate.ErrorResponse
//	@Failure		404		{object}	validate.ErrorResponse
//	@Failure		502		{object}	validate.ErrorResponse
//	@Failure		504		{object}	validate.ErrorResponse
//	@Router			/v1/printers/{id}/print [POST]
//	@Security		Bearer
func (ctrl *V1Controller) HandlePrinterPrint() errchain.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		printerID, err := adapters.RouteUUID(r, "id")
		if err != nil {
			return err
		}

		var job printrelay.PrintJob
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, printJobMaxBodySize)).Decode(&job); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				return validate.NewRequestError(errors.New("request body too large"), http.StatusRequestEntityTooLarge)
			}
			return validate.NewRequestError(errors.New("invalid request body"), http.StatusBadRequest)
		}

		// The server's default Read/WriteTimeout is shorter than the time we
		// may wait for the host, so extend the deadlines for this request. An
		// expired read deadline would otherwise cancel r.Context().
		deadline := time.Now().Add(ctrl.printRelay.Timeout() + 10*time.Second)
		rc := http.NewResponseController(w)
		if err := rc.SetReadDeadline(deadline); err != nil {
			log.Debug().Err(err).Msg("print relay: could not extend read deadline")
		}
		if err := rc.SetWriteDeadline(deadline); err != nil {
			log.Debug().Err(err).Msg("print relay: could not extend write deadline")
		}

		auth := services.NewContext(r.Context())
		err = ctrl.printRelay.Submit(r.Context(), auth.GID, printerID, job)

		var hostErr *printrelay.HostError
		switch {
		case err == nil:
			return server.JSON(w, http.StatusOK, PrintResult{OK: true})
		case errors.Is(err, printrelay.ErrInvalidJob):
			return validate.NewRequestError(err, http.StatusBadRequest)
		case errors.Is(err, printrelay.ErrPrinterNotFound):
			return validate.NewRequestError(err, http.StatusNotFound)
		case errors.Is(err, printrelay.ErrTimeout):
			return validate.NewRequestError(err, http.StatusGatewayTimeout)
		case errors.As(err, &hostErr):
			return validate.NewRequestError(err, http.StatusBadGateway)
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
			// client went away; nothing useful to send
			return validate.NewRequestError(err, http.StatusGatewayTimeout)
		default:
			return err
		}
	}
}
