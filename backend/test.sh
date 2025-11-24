#!/bin/bash

# Script pour exécuter les tests E2E

set -e

echo "🔨 Construction de l'image de test..."
docker build -f Dockerfile.test -t psnes-test:latest . > /dev/null 2>&1

echo "🚀 Démarrage de Redis de test..."
docker-compose -f ../docker-compose.test.yml up -d

echo "⏳ Attente de Redis..."
sleep 3

echo "📦 Installation des dépendances..."
docker run --rm \
  -v /home/pleymor/projects/psnes/backend:/app \
  psnes-test:latest \
  sh -c "npm install > /dev/null 2>&1 && npx prisma generate > /dev/null 2>&1"

echo "🗄️  Configuration de la base de données de test..."
docker run --rm \
  -v /home/pleymor/projects/psnes/backend:/app \
  -e NODE_ENV=test \
  -e DATABASE_URL="file:/app/test.db" \
  psnes-test:latest \
  sh -c "npx prisma db push --skip-generate --accept-data-loss --force-reset"

echo "🧪 Exécution des tests..."
docker run --rm \
  --network host \
  -v /home/pleymor/projects/psnes/backend:/app \
  -e NODE_ENV=test \
  -e DATABASE_URL="file:/app/test.db" \
  -e REDIS_HOST=localhost \
  -e REDIS_PORT=6380 \
  psnes-test:latest \
  sh -c "NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand $@"

TEST_EXIT_CODE=$?

echo "🧹 Nettoyage..."
rm -f test.db test.db-journal

echo "🛑 Arrêt de Redis de test..."
docker-compose -f ../docker-compose.test.yml down

exit $TEST_EXIT_CODE
