import chromadb
import os
import sys
from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer

# Load config
load_dotenv()
CHROMA_PERSIST_DIRECTORY = os.getenv("CHROMA_PERSIST_DIRECTORY", "./chromadb_data")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")

def main():
    print(f"Loading local embedding model ({EMBEDDING_MODEL})...")
    model = SentenceTransformer(EMBEDDING_MODEL)
    client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIRECTORY)
    
    while True:
        print("\n--- ChromaDB CLI (Query Tool) ---")
        print("1. List Collections")
        print("2. Search / Query (Semantic)")
        print("3. Count items in Collection")
        print("4. Peek at data (first 5 items)")
        print("5. Delete a Collection")
        print("q. Exit")
        
        choice = input("\nSelect an option: ").strip().lower()
        
        if choice == '1':
            cols = client.list_collections()
            print(f"\nCollections ({len(cols)}):")
            for c in cols:
                print(f" - {c.name}")
        
        elif choice == '2':
            name = input("Collection name: ")
            query_text = input("Enter your search query: ")
            top_k = input("How many results (default 3)? ")
            top_k = int(top_k) if top_k.isdigit() else 3
            
            try:
                col = client.get_collection(name)
                # Turn text into vector locally
                query_vector = model.encode([query_text]).tolist()
                
                results = col.query(
                    query_embeddings=query_vector,
                    n_results=top_k,
                    include=["documents", "metadatas", "distances"]
                )
                
                print(f"\n--- Search Results for '{query_text}' ---")
                for i in range(len(results['ids'][0])):
                    doc = results['documents'][0][i]
                    meta = results['metadatas'][0][i]
                    dist = results['distances'][0][i]
                    print(f"\n[{i+1}] (Score: {dist:.4f}) Source: {meta.get('source')}")
                    print(f"Content snippet: {doc[:300]}...")
            except Exception as e:
                print(f"Error: {e}")

        elif choice == '3':
            name = input("Collection name: ")
            try:
                col = client.get_collection(name)
                print(f"Count: {col.count()}")
            except Exception as e:
                print(f"Error: {e}")
                
        elif choice == '4':
            name = input("Collection name: ")
            try:
                col = client.get_collection(name)
                results = col.peek(limit=5)
                for i, doc in enumerate(results['documents']):
                    print(f"\n[{i}] Source: {results['metadatas'][i].get('source')}")
                    print(f"Content: {doc[:100]}...")
            except Exception as e:
                print(f"Error: {e}")

        elif choice == '5':
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
