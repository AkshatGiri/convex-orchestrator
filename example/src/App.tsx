import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";

function WorkflowDashboard() {
  const workflows = useQuery(api.example.listWorkflows, { limit: 20 });
  const startWorkflow = useMutation(api.example.startWorkflow);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);

  const steps = useQuery(
    api.example.getWorkflowSteps,
    selectedWorkflow ? { workflowId: selectedWorkflow } : "skip"
  );

  const handleStartGreet = async () => {
    await startWorkflow({
      name: "greet",
      input: { name: "World" },
    });
  };

  const handleStartOrder = async () => {
    await startWorkflow({
      name: "order",
      input: {
        userId: "user_123",
        email: "customer@example.com",
        items: [
          { name: "Widget", price: 29.99 },
          { name: "Gadget", price: 49.99 },
        ],
      },
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "pending":
        return "#ffc107";
      case "running":
        return "#17a2b8";
      case "completed":
        return "#28a745";
      case "failed":
        return "#dc3545";
      default:
        return "#6c757d";
    }
  };

  return (
    <div style={{ textAlign: "left" }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <h3 style={{ marginBottom: "0.5rem" }}>Start New Workflow</h3>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button onClick={handleStartGreet}>Start "greet" Workflow</button>
          <button onClick={handleStartOrder}>Start "order" Workflow</button>
        </div>
        <p style={{ fontSize: "0.85rem", color: "#666", marginTop: "0.5rem" }}>
          Make sure a worker is running: <code>bun example/worker.ts</code>
        </p>
      </div>

      <div style={{ display: "flex", gap: "1rem" }}>
        <div style={{ flex: 1 }}>
          <h3>Workflows</h3>
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: "8px",
              overflow: "hidden",
            }}
          >
            {workflows?.length === 0 && (
              <div style={{ padding: "1rem", color: "#666" }}>
                No workflows yet. Start one above!
              </div>
            )}
            {workflows?.map((workflow) => (
              <div
                key={workflow._id}
                onClick={() => setSelectedWorkflow(workflow._id)}
                style={{
                  padding: "0.75rem 1rem",
                  borderBottom: "1px solid #eee",
                  cursor: "pointer",
                  backgroundColor:
                    selectedWorkflow === workflow._id ? "#f0f7ff" : "white",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <strong>{workflow.name}</strong>
                    <span
                      style={{
                        marginLeft: "0.5rem",
                        fontSize: "0.75rem",
                        color: "#666",
                      }}
                    >
                      {workflow._id.slice(0, 8)}...
                    </span>
                  </div>
                  <span
                    style={{
                      padding: "0.25rem 0.5rem",
                      borderRadius: "4px",
                      fontSize: "0.75rem",
                      backgroundColor: getStatusColor(workflow.status),
                      color: "white",
                    }}
                  >
                    {workflow.status}
                  </span>
                </div>
                <div
                  style={{ fontSize: "0.8rem", color: "#666", marginTop: "0.25rem" }}
                >
                  {new Date(workflow._creationTime).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: 1 }}>
          <h3>Steps</h3>
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: "8px",
              overflow: "hidden",
              minHeight: "200px",
            }}
          >
            {!selectedWorkflow && (
              <div style={{ padding: "1rem", color: "#666" }}>
                Select a workflow to see its steps
              </div>
            )}
            {selectedWorkflow && steps?.length === 0 && (
              <div style={{ padding: "1rem", color: "#666" }}>
                No steps executed yet
              </div>
            )}
            {steps?.map((step) => (
              <div
                key={step._id}
                style={{
                  padding: "0.75rem 1rem",
                  borderBottom: "1px solid #eee",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <strong>{step.name}</strong>
                  <span
                    style={{
                      padding: "0.25rem 0.5rem",
                      borderRadius: "4px",
                      fontSize: "0.75rem",
                      backgroundColor: getStatusColor(step.status),
                      color: "white",
                    }}
                  >
                    {step.status}
                  </span>
                </div>
                {step.output && (
                  <pre
                    style={{
                      fontSize: "0.75rem",
                      backgroundColor: "#f5f5f5",
                      padding: "0.5rem",
                      borderRadius: "4px",
                      marginTop: "0.5rem",
                      overflow: "auto",
                    }}
                  >
                    {JSON.stringify(step.output, null, 2)}
                  </pre>
                )}
                {step.error && (
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "#dc3545",
                      marginTop: "0.5rem",
                    }}
                  >
                    Error: {step.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {selectedWorkflow && (
        <div style={{ marginTop: "1rem" }}>
          <h3>Workflow Details</h3>
          {workflows
            ?.filter((w) => w._id === selectedWorkflow)
            .map((workflow) => (
              <div
                key={workflow._id}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: "8px",
                  padding: "1rem",
                }}
              >
                <div>
                  <strong>Input:</strong>
                </div>
                <pre
                  style={{
                    fontSize: "0.75rem",
                    backgroundColor: "#f5f5f5",
                    padding: "0.5rem",
                    borderRadius: "4px",
                    overflow: "auto",
                  }}
                >
                  {JSON.stringify(workflow.input, null, 2)}
                </pre>
                {workflow.output && (
                  <>
                    <div style={{ marginTop: "0.5rem" }}>
                      <strong>Output:</strong>
                    </div>
                    <pre
                      style={{
                        fontSize: "0.75rem",
                        backgroundColor: "#e8f5e9",
                        padding: "0.5rem",
                        borderRadius: "4px",
                        overflow: "auto",
                      }}
                    >
                      {JSON.stringify(workflow.output, null, 2)}
                    </pre>
                  </>
                )}
                {workflow.error && (
                  <div
                    style={{
                      marginTop: "0.5rem",
                      padding: "0.5rem",
                      backgroundColor: "#ffebee",
                      borderRadius: "4px",
                      color: "#dc3545",
                    }}
                  >
                    <strong>Error:</strong> {workflow.error}
                  </div>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <>
      <h1>Convex Orchestrator Demo</h1>
      <div className="card">
        <WorkflowDashboard />
      </div>
    </>
  );
}

export default App;
