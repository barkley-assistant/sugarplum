#!/bin/sh
# Trap-script fake for the stealth-default-runner escalation test: ignores
# SIGTERM (just like a stuck Firefox child would) and sleeps long enough
# for the parent to escalate to SIGKILL.
trap '' TERM
sleep 30
