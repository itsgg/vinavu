# vinavu: a TypeScript CLI over a Python engine. `make install` puts both on PATH.

.PHONY: install build test test-engine test-cli typecheck uninstall

install: build
	uv tool install --force --reinstall ./engine
	npm link

build: node_modules
	npm run build

node_modules: package.json
	npm install
	@touch node_modules

test: test-engine test-cli

test-engine:
	cd engine && uv run pytest -q

test-cli: node_modules
	npm test

typecheck: node_modules
	npm run typecheck

uninstall:
	-npm unlink -g vinavu
	-uv tool uninstall vinavu-engine
