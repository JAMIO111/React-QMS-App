import { useSearchParams } from "react-router-dom";
import SlidingToggle from "../ui/SlidingToggle";
import CoverageView from "./CoverageView";
import MsaStudiesPage from "./MsaStudiesPage";

const VIEWS = [
  { value: "studies", label: "Studies" },
  { value: "coverage", label: "Coverage" },
];

/** Gauge R&R: the register of studies, or what the control plans use and whether it is covered (`?view=coverage`). */
const MsaHome = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view") === "coverage" ? "coverage" : "studies";
  const toggle = (
    <SlidingToggle
      ariaLabel="Gauge R&R view"
      options={VIEWS}
      value={view}
      onChange={(v) => setSearchParams(v === "coverage" ? { view: "coverage" } : {})}
    />
  );
  return view === "coverage" ? <CoverageView toggle={toggle} /> : <MsaStudiesPage toggle={toggle} />;
};

export default MsaHome;
