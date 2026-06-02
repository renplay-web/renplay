.PHONY: build run dev clean

build:
	docker build -t renplay:latest -f deploy/nginx/Dockerfile .

run:
	docker run -p 8080:8080 \
		-e GAMES_DIR=/games \
		-e DATA_DIR=/data \
		-v $(PWD)/games:/games \
		-v $(PWD)/data:/data \
		renplay:latest

dev:
	docker compose up --build

clean:
	rm -rf selector/dist selector/node_modules
