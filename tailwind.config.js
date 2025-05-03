module.exports = {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primaryBG: "rgb(var(--primaryBG) / <alpha-value>)",
        secondaryBG: "rgb(var(--secondaryBG) / <alpha-value>)",
        primaryText: "rgb(var(--primaryText) / <alpha-value>)",
        secondaryText: "rgb(var(--secondaryText) / <alpha-value>)",
        primaryBorder: "rgb(var(--primaryBorder) / <alpha-value>)",
        secondaryBorder: "rgb(var(--secondaryBorder) / <alpha-value>)",
        primaryBrand: "rgb(var(--primaryBrand) / <alpha-value>)",
        secondaryBrand: "rgb(var(--secondaryBrand) / <alpha-value>)",
      },
    },
  },
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
