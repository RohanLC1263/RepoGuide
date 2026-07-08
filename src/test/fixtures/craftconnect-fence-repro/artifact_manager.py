class ArtifactManager:
    def _save_atomic(self, path, content, is_json=False, is_binary=False, mode='w'):
        """Atomically write content to path."""
        dir_name = path.parent
        dir_name.mkdir(parents=True, exist_ok=True)

        # Create temp file in the same directory to ensure atomic move is possible (same filesystem)
        import tempfile
        prefix = f".tmp_{path.name}_"

        try:
            with tempfile.NamedTemporaryFile(mode, delete=False, dir=dir_name, prefix=prefix, suffix=".tmp", encoding="utf-8") as tmp:
                if is_json:
                    json.dump(content, tmp, ensure_ascii=False, indent=2)
                elif is_binary:
                    tmp.write(content)
                else:
                    tmp.write(content)
                tmp_path = Path(tmp.name)
        finally:
            pass

        os.replace(tmp_path, path)
        logger.debug(f"Atomically wrote to {path}")
