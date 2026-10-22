"""python -m unittest discover sidecar   (with the sidecar venv's python)"""

import unittest

from sympy_server import BadInput, check_text, run_op, run_with_timeout


class Ops(unittest.TestCase):
    def test_solve_equation(self):
        self.assertEqual(run_op({"op": "solve", "expr": "2*(x+3)", "rhs": "10"})["result"], "[2]")

    def test_solve_quadratic(self):
        self.assertEqual(run_op({"op": "solve", "expr": "x^2-5*x+6"})["result"], "[2, 3]")

    def test_factor_expand_simplify(self):
        self.assertEqual(run_op({"op": "factor", "expr": "x^2-5*x+6"})["result"], "(x - 3)*(x - 2)")
        self.assertEqual(run_op({"op": "expand", "expr": "2*(x-2)^2-3"})["result"], "2*x**2 - 8*x + 5")
        self.assertEqual(run_op({"op": "simplify", "expr": "(x^2-1)/(x-1)"})["result"], "x + 1")

    def test_calculus(self):
        self.assertEqual(run_op({"op": "derivative", "expr": "x^3*sin(x)"})["result"], "x**3*cos(x) + 3*x**2*sin(x)")
        self.assertEqual(run_op({"op": "integral", "expr": "2*x"})["result"], "x**2")
        self.assertEqual(run_op({"op": "integral", "expr": "2*x", "from": "0", "to": "3"})["result"], "9")
        self.assertEqual(run_op({"op": "limit", "expr": "sin(x)/x", "at": "0"})["result"], "1")

    def test_capital_letters_stay_variables(self):
        self.assertEqual(run_op({"op": "expand", "expr": "(E+I)^2"})["result"], "E**2 + 2*E*I + I**2")

    def test_picks_x_when_several_variables(self):
        out = run_op({"op": "solve", "expr": "a*x+b"})
        self.assertEqual(out["variable"], "x")
        self.assertEqual(out["result"], "[-b/a]")


class Safety(unittest.TestCase):
    def test_rejects_code(self):
        for bad in ["__import__('os')", "x.__class__", "open(x)", "x; y", "lambda x: x", "'a'", "x[0]"]:
            with self.assertRaises(BadInput, msg=bad):
                check_text(bad)

    def test_bad_input_comes_back_as_error(self):
        out = run_with_timeout({"op": "expand", "expr": "__import__('os').system('true')"})
        self.assertFalse(out["ok"])

    def test_unknown_op(self):
        self.assertFalse(run_with_timeout({"op": "eval", "expr": "x"})["ok"])


if __name__ == "__main__":
    unittest.main()
