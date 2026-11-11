export async function getStudyRecommendations(preferences, client = global.fetch) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000); // Таймаут от 5 секунди

  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      throw new Error('API key is missing');
    }

    const response = await client('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Recommend study groups for: ${preferences}` }] }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Provider error: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('AI recommendation error:', error.message);
    // Fallback съобщение, когато моделът е недостъпен или липсва ключ
    return {
      fallback: true,
      message: "AI recommendations are currently unavailable, please browse groups manually"
    };
  }
}