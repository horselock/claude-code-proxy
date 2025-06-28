$uri = "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"

$headers = @{
    "Authorization" = "Bearer ya29.a0AS3H6N..."
    "Content-Type"  = "application/json"
}

$body = @{
    model    = "gemini-2.5-pro"
    project  = "singular-machine-ff5mk"
    request  = @{
        contents = @(@{ role = "user"; parts = @(@{ text = "hi" }) })
    	tools = @()
    	generationConfig = @{
     	   thinkingConfig = @{ includeThoughts = $true }
    	}
    }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body