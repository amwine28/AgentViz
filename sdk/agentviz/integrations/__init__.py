"""Framework adapters that bridge real agent frameworks onto AgentViz's verified core.

Each adapter is a thin translator: it produces the `workflow(session)` callable the
re-run engine already consumes, so grounded counterfactual credit works without
reimplementing any of the credit math or the dry-run safety layer.
"""
