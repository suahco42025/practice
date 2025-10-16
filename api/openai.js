import Groq from 'groq-sdk';  // Assuming you're using groq-sdk

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,  // Use GROQ_API_KEY env var in Vercel
});

// Supported models (update as needed from https://console.groq.com/docs/models)
const SUPPORTED_MODELS = {
  'gpt-3.5-turbo': 'llama-3.1-8b-instant',  // Map OpenAI-style requests to Groq
  'default': 'llama-3.1-8b-instant',        // Fallback for frontend requests
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { model = 'default', messages, max_tokens = 150, temperature = 0.7 } = req.body;

    // Map to supported Groq model
    const groqModel = SUPPORTED_MODELS[model] || SUPPORTED_MODELS['default'];
    
    console.log(`Using Groq model: ${groqModel} for request with ${messages.length} messages`);

    const completion = await groq.chat.completions.create({
      model: groqModel,
      messages,
      max_tokens,
      temperature,
    });

    res.status(200).json(completion);
  } catch (error) {
    console.error('Groq API Error:', error);
    
    // Handle deprecation specifically
    if (error.status === 400 && error.error?.code === 'model_decommissioned') {
      return res.status(400).json({ 
        error: 'Model deprecated. Try enabling a different model in settings or contact support.' 
      });
    }
    
    res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
  }
}
