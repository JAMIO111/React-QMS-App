"""
Reference values for the MSA statistics tests (api/src/msa/*.spec.ts).

Run by hand (needs numpy, scipy, statsmodels, pandas — they are NOT product dependencies):
    python3 api/src/msa/reference/generate.py > api/src/msa/reference/reference.json

Everything here comes from independent implementations (scipy quadrature and distributions, statsmodels' ANOVA and
inter-rater functions) or from plain numpy code written differently from the TypeScript. The random data are seeded, so
the file is reproducible. Last generated with scipy 1.18.1, numpy 2.5.3, statsmodels 0.15.0.
"""
import json
import numpy as np
import pandas as pd
from scipy import integrate, stats
from scipy.stats import norm
import statsmodels.api as sm
from statsmodels.formula.api import ols
from statsmodels.stats.inter_rater import cohens_kappa, fleiss_kappa

out = {}

# ── range constants: d2 = E[W], d3 = sd(W) for the range W of m standard normals ───────────────────────────────────────
def range_moments(m):
    def f(w):
        g = lambda x: norm.pdf(x) * norm.pdf(x + w) * (norm.cdf(x + w) - norm.cdf(x)) ** (m - 2)
        return m * (m - 1) * integrate.quad(g, -12, 12, epsabs=1e-13, epsrel=1e-13, limit=400)[0]
    e1 = integrate.quad(lambda w: w * f(w), 0, 18, epsabs=1e-12, epsrel=1e-12, limit=400)[0]
    e2 = integrate.quad(lambda w: w * w * f(w), 0, 18, epsabs=1e-12, epsrel=1e-12, limit=400)[0]
    return e1, float(np.sqrt(e2 - e1 * e1))

out["rangeConstants"] = {str(m): dict(zip(("d2", "d3"), range_moments(m))) for m in range(2, 26)}

# ── distributions ────────────────────────────────────────────────────────────────────────────────────────────────────
out["fSf"] = [[f, d1, d2, float(stats.f.sf(f, d1, d2))] for f, d1, d2 in
              [(0.434, 18, 60), (3.5, 9, 18), (34.44, 2, 18), (213.5, 9, 18), (1.0, 5, 5), (0.01, 2, 30), (12.0, 1, 2), (2.2, 40, 90), (50.0, 3, 120), (0.9, 12, 12)]]
out["tTwoSided"] = [[t, df, float(2 * stats.t.sf(abs(t), df))] for t, df in
                    [(0.0, 10), (1.0, 4), (2.5, 24), (-2.5, 24), (3.9, 49), (0.31, 7), (6.0, 2), (1.96, 1000), (0.2, 99)]]

# ── crossed ANOVA ────────────────────────────────────────────────────────────────────────────────────────────────────
def anova_case(seed, parts, appraisers, trials, op_sd, part_sd, inter_sd, noise_sd):
    rng = np.random.default_rng(seed)
    partf = rng.normal(0, part_sd, parts)
    opf = rng.normal(0, op_sd, appraisers)
    inter = rng.normal(0, inter_sd, (appraisers, parts))
    cube = np.empty((appraisers, parts, trials))
    for a in range(appraisers):
        for p in range(parts):
            cube[a, p, :] = 10 + partf[p] + opf[a] + inter[a, p] + rng.normal(0, noise_sd, trials)
    cube = np.round(cube, 4)
    rows = [dict(op=f"o{a}", part=f"p{p}", y=cube[a, p, t]) for a in range(appraisers) for p in range(parts) for t in range(trials)]
    tab = sm.stats.anova_lm(ols("y ~ C(part)*C(op)", pd.DataFrame(rows)).fit(), typ=2)
    g = lambda name, col: float(tab.loc[name, col])
    return {
        "cube": cube.tolist(),
        "anova": {
            "part": {"df": g("C(part)", "df"), "ss": g("C(part)", "sum_sq"), "f": g("C(part)", "F"), "p": g("C(part)", "PR(>F)")},
            "appraiser": {"df": g("C(op)", "df"), "ss": g("C(op)", "sum_sq"), "f": g("C(op)", "F"), "p": g("C(op)", "PR(>F)")},
            "interaction": {"df": g("C(part):C(op)", "df"), "ss": g("C(part):C(op)", "sum_sq"), "f": g("C(part):C(op)", "F"), "p": g("C(part):C(op)", "PR(>F)")},
            "repeatability": {"df": float(tab.loc["Residual", "df"]), "ss": float(tab.loc["Residual", "sum_sq"])},
        },
    }

out["anovaCases"] = [
    {"name": "10x3x3, small appraiser effect, no interaction", **anova_case(11, 10, 3, 3, 0.25, 1.1, 0.0, 0.2)},
    {"name": "8x4x2, large interaction", **anova_case(12, 8, 4, 2, 0.3, 1.0, 0.6, 0.15)},
    {"name": "5x2x4, tiny design", **anova_case(13, 5, 2, 4, 0.1, 0.8, 0.05, 0.3)},
]

# ── Type 1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
def type1_case(seed, n, ref, bias, sd, lower, upper, k=20, l=6):
    rng = np.random.default_rng(seed)
    x = np.round(ref + bias + rng.normal(0, sd, n), 4)
    mean, s = float(x.mean()), float(x.std(ddof=1))
    t = (mean - ref) / (s / np.sqrt(n))
    tol = upper - lower
    cg = (k / 100 * tol) / (l * s)
    cgk = (k / 200 * tol - abs(mean - ref)) / (l / 2 * s)
    return {"values": x.tolist(), "reference": ref, "lower": lower, "upper": upper, "k": k, "l": l,
            "mean": mean, "sd": s, "bias": mean - ref, "t": float(t), "p": float(2 * stats.t.sf(abs(t), n - 1)), "cg": float(cg), "cgk": float(cgk)}

out["type1Cases"] = [type1_case(21, 50, 25.0, 0.004, 0.006, 24.9, 25.1), type1_case(22, 30, 10.0, 0.05, 0.02, 9.8, 10.2, 20, 6), type1_case(23, 25, 5.0, -0.01, 0.01, 4.9, 5.1, 20, 4)]

# ── attribute agreement ──────────────────────────────────────────────────────────────────────────────────────────────
def attribute_case(seed, n, k, r, error_rates):
    rng = np.random.default_rng(seed)
    standard = rng.random(n) < 0.6                      # True = a good part (should be accepted)
    ratings = np.empty((k, n, r), dtype=bool)
    for a in range(k):
        for s in range(n):
            for t in range(r):
                wrong = rng.random() < error_rates[a]
                ratings[a, s, t] = (not standard[s]) if wrong else standard[s]
    res = {"standard": standard.tolist(), "ratings": ratings.tolist(), "appraisers": []}
    for a in range(k):
        x = ratings[a]
        within_match = int(sum(len(set(x[s].tolist())) == 1 for s in range(n)))
        vs_std_match = int(sum(all(x[s, t] == standard[s] for t in range(r)) for s in range(n)))
        good, bad = standard, ~standard
        good_acc = int(sum(x[s, t] for s in range(n) if good[s] for t in range(r)))
        good_n = int(sum(r for s in range(n) if good[s]))
        bad_acc = int(sum(x[s, t] for s in range(n) if bad[s] for t in range(r)))
        bad_n = int(sum(r for s in range(n) if bad[s]))
        correct = good_acc + (bad_n - bad_acc)
        # Fleiss: subjects = samples, raters = trials
        table = np.array([[int((~x[s]).sum()), int(x[s].sum())] for s in range(n)])
        # Minitab 'vs standard': per trial, Fleiss kappa of (trial, standard) as two raters, averaged over trials
        per_trial = []
        for t in range(r):
            tb = np.array([[int((x[s, t] == 0)) + int(not standard[s]), int(x[s, t]) + int(standard[s])] for s in range(n)])
            per_trial.append(float(fleiss_kappa(tb, method="fleiss")))
        res["appraisers"].append({
            "withinMatched": within_match, "vsStandardMatched": vs_std_match,
            "goodOpportunities": good_n, "goodRejected": good_n - good_acc, "badOpportunities": bad_n, "badAccepted": bad_acc,
            "effectiveness": correct / (n * r),
            "miss": (bad_acc / bad_n) if bad_n else None, "falseAlarm": ((good_n - good_acc) / good_n) if good_n else None,
            "kappaWithin": None if len(set(table.sum(0).tolist())) == 1 and (table.sum(0) == 0).any() else float(fleiss_kappa(table, method="fleiss")),
            "kappaVsStandard": float(np.mean(per_trial)),
        })
    allr = ratings.reshape(k, n, r).transpose(1, 0, 2).reshape(n, k * r)
    res["betweenMatched"] = int(sum(len(set(allr[s].tolist())) == 1 for s in range(n)))
    res["allVsStandardMatched"] = int(sum(all(allr[s, j] == standard[s] for j in range(k * r)) for s in range(n)))
    res["kappaBetween"] = float(fleiss_kappa(np.array([[int((~allr[s]).sum()), int(allr[s].sum())] for s in range(n)]), method="fleiss"))
    return res

out["attributeCases"] = [attribute_case(31, 40, 3, 3, [0.05, 0.10, 0.2]), attribute_case(32, 30, 2, 2, [0.02, 0.35]), attribute_case(33, 50, 3, 3, [0.0, 0.04, 0.08])]

print(json.dumps(out, indent=1))
