export async function convertCurrency(from, to, amount) {
  const apiKey = import.meta.env.VITE_UNIRATE_API_KEY;

  const url = `https://api.unirateapi.com/api/convert?api_key=${apiKey}&from=${from}&to=${to}&amount=${amount}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Unirate API error: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Currency conversion failed:", error);
    throw error;
  }
}
