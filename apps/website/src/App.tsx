import Hero from "./components/Hero.js";
import Footer from "./components/Footer.js";
import Packages from "./components/Packages.js";
import Pipeline from "./components/Pipeline.js";
import SpecGraphSection from "./components/SpecGraphSection.js";
import StatusBar from "./components/StatusBar.js";
import Studio from "./components/Studio.js";
import Topbar from "./components/Topbar.js";

export default function App() {
  return (
    <div className="page">
      <header className="hdr">
        <StatusBar />
        <Topbar />
      </header>
      <div className="wrap">
        <main>
          <Hero />
          <SpecGraphSection />
          <Pipeline />
          <Studio />
          <Packages />
        </main>
        <Footer />
      </div>
    </div>
  );
}
