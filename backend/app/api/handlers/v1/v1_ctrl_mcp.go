package v1

import (
	"context"
	"fmt"
	"net/http"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/sysadminsmedia/homebox/backend/internal/core/services"
	"github.com/sysadminsmedia/homebox/backend/internal/data/repo"
	"github.com/google/uuid"
)

type MCPController struct {
	server *server.MCPServer
	sse    *server.SSEServer
	svc    *services.AllServices
	repo   *repo.AllRepos
}

func NewMCPController(svc *services.AllServices, repos *repo.AllRepos) *MCPController {
	mcpServer := server.NewMCPServer("homebox-mcp", "1.0.0")

	ctrl := &MCPController{
		server: mcpServer,
		sse:    server.NewSSEServer(mcpServer),
		svc:    svc,
		repo:   repos,
	}

	ctrl.registerTools()

	return ctrl
}

func (ctrl *MCPController) registerTools() {
	// Tool: search_items
	searchTool := mcp.NewTool("search_items",
		mcp.WithDescription("Search for inventory items by query string."),
		mcp.WithString("query", mcp.Required(), mcp.Description("The search query")),
	)

	ctrl.server.AddTool(searchTool, func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args, ok := request.Params.Arguments.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("invalid arguments")
		}
		query, ok := args["query"].(string)
		if !ok {
			return nil, fmt.Errorf("query argument is required and must be a string")
		}

		userCtx := services.UseUserCtx(ctx)
		if userCtx == nil {
			return nil, fmt.Errorf("unauthorized")
		}

		// Pagination parameters (default to first page)
		queryParam := repo.ItemQuery{
			Search: query,
			Page: 1,
			PageSize: 50,
		}
		items, err := ctrl.repo.Items.QueryByGroup(ctx, userCtx.GroupID, queryParam)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}

		resultStr := fmt.Sprintf("Found %d items.\n", items.Total)
		for _, item := range items.Items {
            locID := "None"
            if item.Location != nil {
                locID = item.Location.ID.String()
            }
			resultStr += fmt.Sprintf("- %s (ID: %s, Location ID: %s, Quantity: %d)\n", item.Name, item.ID, locID, item.Quantity)
		}

		return mcp.NewToolResultText(resultStr), nil
	})

	// Tool: list_locations
	locationsTool := mcp.NewTool("list_locations",
		mcp.WithDescription("List all storage locations in the inventory."),
	)

	ctrl.server.AddTool(locationsTool, func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		userCtx := services.UseUserCtx(ctx)
		if userCtx == nil {
			return nil, fmt.Errorf("unauthorized")
		}

		locations, err := ctrl.repo.Locations.GetAll(ctx, userCtx.GroupID, repo.LocationQuery{})
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}

		resultStr := fmt.Sprintf("Found %d locations.\n", len(locations))
		for _, loc := range locations {
			resultStr += fmt.Sprintf("- %s (ID: %s)\n", loc.Name, loc.ID)
		}

		return mcp.NewToolResultText(resultStr), nil
	})

	// Tool: get_item
	getItemTool := mcp.NewTool("get_item",
		mcp.WithDescription("Get detailed information about a specific item."),
		mcp.WithString("item_id", mcp.Required(), mcp.Description("The UUID of the item")),
	)

	ctrl.server.AddTool(getItemTool, func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args, ok := request.Params.Arguments.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("invalid arguments")
		}
		itemID, ok := args["item_id"].(string)
		if !ok {
			return nil, fmt.Errorf("item_id argument is required and must be a string")
		}

		userCtx := services.UseUserCtx(ctx)
		if userCtx == nil {
			return nil, fmt.Errorf("unauthorized")
		}

		
        
        
        parsedID, err := uuid.Parse(itemID)
        if err != nil {
            return nil, fmt.Errorf("invalid item_id format")
        }
        item, err := ctrl.repo.Items.GetOneByGroup(ctx, userCtx.GroupID, parsedID)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}

		locID := "None"
        if item.Location != nil {
            locID = item.Location.ID.String()
        }
        resultStr := fmt.Sprintf("Item: %s\nID: %s\nDescription: %s\nQuantity: %d\nLocation ID: %s\n", 
			item.Name, item.ID, item.Description, item.Quantity, locID)

		if item.PurchasePrice > 0 {
			resultStr += fmt.Sprintf("Purchase Price: %f\n", item.PurchasePrice)
		}
		
		if item.PurchaseFrom != "" {
			resultStr += fmt.Sprintf("Purchased From: %s\n", item.PurchaseFrom)
		}

		return mcp.NewToolResultText(resultStr), nil
	})
}

// HandleSSE establishes the SSE connection for the MCP Server
func (ctrl *MCPController) HandleSSE(w http.ResponseWriter, r *http.Request) {
	ctrl.sse.SSEHandler().ServeHTTP(w, r)
}

// HandleMessage receives JSON-RPC 2.0 messages for the MCP Server
func (ctrl *MCPController) HandleMessage(w http.ResponseWriter, r *http.Request) {
	ctrl.sse.MessageHandler().ServeHTTP(w, r)
}
