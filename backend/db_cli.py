import chromadb
import os
import sys
from dotenv import load_dotenv

# Load config
load_dotenv()
CHROMA_PERSIST_DIRECTORY = os.getenv("CHROMA_PERSIST_DIRECTORY", "./chromadb_data")

def main():
    client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIRECTORY)
    
    while True:
        print("\n--- ChromaDB CLI ---")
        print("1. List Collections")
        print("2. Count items in Collection")
        print("3. Peek at data (first 5 items)")
        print("4. Delete a Collection")
        print("q. Exit")
        
        choice = input("\nSelect an option: ").strip().lower()
        
        if choice == '1':
            cols = client.list_collections()
            print(f"\nCollections ({len(cols)}):")
            for c in cols:
                print(f" - {c.name}")
        
        elif choice == '2':
            name = input("Collection name: ")
            try:
                col = client.get_collection(name)
                print(f"Count: {col.count()}")
            except Exception as e:
                print(f"Error: {e}")
                
        elif choice == '3':
            name = input("Collection name: ")
            try:
                col = client.get_collection(name)
                results = col.peek(limit=5)
                for i, doc in enumerate(results['documents']):
                    print(f"\n[{i}] Source: {results['metadatas'][i].get('source')}")
                    print(f"Content: {doc[:100]}...")
            except Exception as e:
                print(f"Error: {e}")

        elif choice == '4':
            name = input("Collection to DELETE (Warning: permanent): ")
            confirm = input(f"Type '{name}' to confirm: ")
            if confirm == name:
                client.delete_collection(name)
                print("Deleted.")
            else:
                print("Aborted.")

        elif choice == 'q':
            break

if __name__ == "__main__":
    main()
