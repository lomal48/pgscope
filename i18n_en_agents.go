package main

// English for agents.go and the API-key lookup shared with ingest.go.

func init() {
	registerEN(map[string]string{
		"Хранилище временно недоступно":     "Storage is temporarily unavailable",
		"Некорректный идентификатор агента": "Invalid agent ID",
	})
}
