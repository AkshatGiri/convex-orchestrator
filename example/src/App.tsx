import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";

type WorkflowStatus = "pending" | "running" | "completed" | "failed";
type TabType = "steps" | "input" | "output";

function StatusBadge({ status }: { status: WorkflowStatus }) {
  return (
    <span className={`status-badge ${status}`}>
      <span className="status-badge-dot" />
      {status}
    </span>
  );
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

function formatDuration(start?: number, end?: number): string {
  if (!start) return "-";
  const endTime = end || Date.now();
  const diffMs = endTime - start;
  if (diffMs < 1000) return `${diffMs}ms`;
  if (diffMs < 60000) return `${(diffMs / 1000).toFixed(1)}s`;
  return `${(diffMs / 60000).toFixed(1)}m`;
}

function WorkflowDashboard() {
  const workflows = useQuery(api.example.listWorkflows, { limit: 50 });
  const startWorkflow = useMutation(api.example.startWorkflow);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>("steps");
  const [startingWorkflow, setStartingWorkflow] = useState<string | null>(null);

  const steps = useQuery(
    api.example.getWorkflowSteps,
    selectedWorkflow ? { workflowId: selectedWorkflow as any } : "skip"
  );

  const selectedWorkflowData = workflows?.find((w) => w._id === selectedWorkflow);

  const handleStartWorkflow = async (name: string, input: any) => {
    setStartingWorkflow(name);
    try {
      const id = await startWorkflow({ name, input });
      setSelectedWorkflow(id);
      setActiveTab("steps");
    } finally {
      setStartingWorkflow(null);
    }
  };

  const handleStartGreet = () =>
    handleStartWorkflow("greet", { name: "World" });

  const handleStartOrder = () =>
    handleStartWorkflow("order", {
      userId: "user_123",
      email: "customer@example.com",
      items: [
        { name: "Widget", price: 29.99 },
        { name: "Gadget", price: 49.99 },
      ],
    });

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="app-logo">
          <div className="app-logo-icon">CO</div>
          <span className="app-logo-text">Convex Orchestrator</span>
          <span className="app-logo-badge">Demo</span>
        </div>
        <div className="app-actions">
          <div className="toolbar-hint">
            Worker: <code>bun example/worker.ts</code>
          </div>
        </div>
      </header>

      {/* Toolbar */}
      <div className="toolbar">
        <div className="toolbar-section">
          <span className="toolbar-label">New Workflow</span>
          <button
            className="btn btn-primary"
            onClick={handleStartGreet}
            disabled={startingWorkflow !== null}
          >
            {startingWorkflow === "greet" ? <span className="spinner" /> : null}
            greet
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleStartOrder}
            disabled={startingWorkflow !== null}
          >
            {startingWorkflow === "order" ? <span className="spinner" /> : null}
            order
          </button>
        </div>
      </div>

      {/* Main Dashboard */}
      <div className="dashboard">
        {/* Workflow List Panel */}
        <div className="workflow-list-panel">
          <div className="panel-header">
            <span className="panel-title">Workflows</span>
            <span className="panel-count">{workflows?.length ?? 0}</span>
          </div>
          <div className="workflow-list">
            {workflows?.length === 0 && (
              <div className="empty-state">
                <div className="empty-state-icon">⚡</div>
                <div className="empty-state-title">No workflows yet</div>
                <div className="empty-state-description">
                  Start a workflow using the buttons above
                </div>
              </div>
            )}
            {workflows?.map((workflow, index) => (
              <div
                key={workflow._id}
                className={`workflow-item ${selectedWorkflow === workflow._id ? "selected" : ""}`}
                onClick={() => {
                  setSelectedWorkflow(workflow._id);
                  setActiveTab("steps");
                }}
                style={{ animationDelay: `${index * 30}ms` }}
              >
                <div className="workflow-item-header">
                  <div className="workflow-item-info">
                    <div className="workflow-item-name">{workflow.name}</div>
                    <div className="workflow-item-id">
                      {workflow._id.slice(0, 12)}...
                    </div>
                  </div>
                  <StatusBadge status={workflow.status} />
                </div>
                <div className="workflow-item-meta">
                  <span className="workflow-item-time">
                    {formatTime(workflow._creationTime)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Detail Panel */}
        <div className="detail-panel">
          {!selectedWorkflow ? (
            <div className="detail-panel-empty">
              <div className="detail-panel-empty-icon">←</div>
              <div className="detail-panel-empty-text">
                Select a workflow to view details
              </div>
            </div>
          ) : selectedWorkflowData ? (
            <div className="detail-content">
              {/* Detail Header */}
              <div className="detail-header">
                <div className="detail-header-info">
                  <div className="detail-header-title">
                    <span className="detail-header-name">
                      {selectedWorkflowData.name}
                    </span>
                    <StatusBadge status={selectedWorkflowData.status} />
                  </div>
                  <span className="detail-header-id">
                    ID: {selectedWorkflowData._id}
                  </span>
                </div>
              </div>

              {/* Tabs */}
              <div className="tabs">
                <button
                  className={`tab ${activeTab === "steps" ? "active" : ""}`}
                  onClick={() => setActiveTab("steps")}
                >
                  Steps
                  <span className="tab-count">{steps?.length ?? 0}</span>
                </button>
                <button
                  className={`tab ${activeTab === "input" ? "active" : ""}`}
                  onClick={() => setActiveTab("input")}
                >
                  Input
                </button>
                <button
                  className={`tab ${activeTab === "output" ? "active" : ""}`}
                  onClick={() => setActiveTab("output")}
                >
                  Result
                </button>
              </div>

              {/* Tab Content */}
              {activeTab === "steps" && (
                <div className="steps-panel">
                  {steps?.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-state-icon">⏳</div>
                      <div className="empty-state-title">No steps yet</div>
                      <div className="empty-state-description">
                        Steps will appear here as the workflow executes
                      </div>
                    </div>
                  ) : (
                    <div className="steps-list">
                      {steps?.map((step, index) => (
                        <div key={step._id} className="step-item">
                          <div className="step-header">
                            <div className="step-header-info">
                              <span className="step-number">{index + 1}</span>
                              <span className="step-name">{step.name}</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                              <span className="step-duration">
                                {formatDuration(step.startedAt, step.completedAt)}
                              </span>
                              <StatusBadge status={step.status} />
                            </div>
                          </div>
                          {step.output && (
                            <div className="step-output">
                              <div className="step-output-label">Output</div>
                              <pre>{JSON.stringify(step.output, null, 2)}</pre>
                            </div>
                          )}
                          {step.error && (
                            <div className="step-error">
                              <div className="step-error-text">
                                Error: {step.error}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeTab === "input" && (
                <div className="steps-panel">
                  <div className="data-section">
                    <div className="data-label">Workflow Input</div>
                    <div className="data-content">
                      <pre>
                        {JSON.stringify(selectedWorkflowData.input, null, 2)}
                      </pre>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "output" && (
                <div className="steps-panel">
                  {selectedWorkflowData.output && (
                    <div className="data-section">
                      <div className="data-label">Workflow Output</div>
                      <div className="data-content success">
                        <pre>
                          {JSON.stringify(selectedWorkflowData.output, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                  {selectedWorkflowData.error && (
                    <div className="data-section">
                      <div className="data-label">Error</div>
                      <div className="data-content error">
                        <pre>{selectedWorkflowData.error}</pre>
                      </div>
                    </div>
                  )}
                  {!selectedWorkflowData.output && !selectedWorkflowData.error && (
                    <div className="empty-state">
                      <div className="empty-state-icon">⏳</div>
                      <div className="empty-state-title">No result yet</div>
                      <div className="empty-state-description">
                        The workflow is still in progress
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return <WorkflowDashboard />;
}
