# Changelog1

## 0.1.5

## 0.1.4

Adding ctx.sleep and ctx.sleepUntil api to put workflows to sleep. \
\
Ading concurrency to workers so they can handle multiple workflows at once. \
\
Adding signal primitive to pause workflows until a signal is externally
triggered.

## 0.1.3

Fixing workflow processing fifo logic. Now the worker picks the oldest workflow
to process from the list it is scoped for. \
\
Adding a fastpath for the "\*" wildcard workers to prevent query degredation.
Allow workers to pick up any of the workflows without name scoping. \

Demo UI upgrade.

## 0.1.2

## 0.1.2-alpha.1

## 0.1.2-alpha.0

## 0.1.1

## 0.1.1-alpha.0:

## 0.0.0

- Initial release.
