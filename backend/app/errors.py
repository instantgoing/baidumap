class BackendServiceError(Exception):
    def __init__(self, message: str, *, kind: str = "service_error", status_code: int = 502, details: str | None = None):
        super().__init__(message)
        self.kind = kind
        self.status_code = status_code
        self.details = details
