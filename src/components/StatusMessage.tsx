interface StatusMessageProps {
  message: string;
  type?: "success" | "error" | "info";
}

export function StatusMessage({ message, type = "info" }: StatusMessageProps) {
  if (!message) return null;
  return (
    <div className={`status ${type}`} role="status">
      {message}
    </div>
  );
}
