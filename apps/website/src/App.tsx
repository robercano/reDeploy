import Hero from "./components/Hero.js";
import Benefits from "./components/Benefits.js";
import Features from "./components/Features.js";
import Footer from "./components/Footer.js";

export default function App() {
  return (
    <div className="page">
      <main>
        <Hero />
        <Benefits />
        <Features />
      </main>
      <Footer />
    </div>
  );
}
