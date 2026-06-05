.PHONY: build run stop logs shell dev clean

build:
	docker build -t renplay:latest -f deploy/nginx/Dockerfile .

run:
	docker run -d --name renplay -p 8080:8080 \
		-e GAMES_DIR=/games \
		-e DATA_DIR=/data \
		-v $(PWD)/games:/games \
		-v $(PWD)/data:/data \
		renplay:latest
	@echo "Running at http://localhost:8080"

stop:
	docker stop renplay && docker rm renplay

logs:
	docker logs -f renplay

shell:
	docker exec -it renplay sh

dev:
	docker compose up --build

clean:
	docker rm -f renplay 2>/dev/null || true
	rm -rf selector/dist selector/node_modules server/dist
