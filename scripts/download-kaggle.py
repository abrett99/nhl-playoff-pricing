import kagglehub
import shutil
import os

target_dir = os.path.join(os.getcwd(), 'data', 'raw', 'kaggle')
os.makedirs(target_dir, exist_ok=True)

print("Downloading historical dataset...")
historical_path = kagglehub.dataset_download("jonathanncoletti/nhl-historical-game-data")
print("  Downloaded to:", historical_path)

historical_target = os.path.join(target_dir, 'historical')
if os.path.exists(historical_target):
    shutil.rmtree(historical_target)
shutil.copytree(historical_path, historical_target)
print("  Copied to:", historical_target)

print("")
print("Downloading 2024-25 advanced metrics dataset...")
recent_path = kagglehub.dataset_download("jonathanncoletti/nhl-game-data-2024-2025-advanced-metrics")
print("  Downloaded to:", recent_path)

recent_target = os.path.join(target_dir, '2024-25')
if os.path.exists(recent_target):
    shutil.rmtree(recent_target)
shutil.copytree(recent_path, recent_target)
print("  Copied to:", recent_target)

print("")
print("Files downloaded:")
for root, dirs, files in os.walk(target_dir):
    for f in files:
        full_path = os.path.join(root, f)
        size_mb = os.path.getsize(full_path) / 1_000_000
        rel_path = os.path.relpath(full_path, os.getcwd())
        print("  " + rel_path + "  (" + str(round(size_mb, 1)) + " MB)")
