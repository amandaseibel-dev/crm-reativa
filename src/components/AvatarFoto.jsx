import { useFotoPerfil } from "../utils/fotoPerfil";

// Avatar de foto de perfil (bucket privado). Recebe o CAMINHO INTERNO do objeto
// (usuarios.foto_path), busca uma URL assinada de curta duração e exibe a foto;
// enquanto carrega, em falha ou sem foto, mostra a inicial do nome (fallback),
// nunca quebrando a tela.
export function AvatarFoto({ path, nome, tamanho = 30, style }) {
  const url = useFotoPerfil(path);
  const inicial = (nome || "?").charAt(0).toUpperCase();
  const base = {
    width: tamanho,
    height: tamanho,
    borderRadius: "50%",
    objectFit: "cover",
    ...(style || {}),
  };

  if (!url) {
    return (
      <span
        style={{
          ...base,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#334155",
          color: "#fff",
          fontWeight: 700,
          fontSize: Math.max(10, Math.round(tamanho * 0.45)),
        }}
      >
        {inicial}
      </span>
    );
  }

  return (
    <img
      src={url}
      alt={nome || "Foto"}
      style={base}
      onError={(e) => {
        e.currentTarget.style.visibility = "hidden";
      }}
    />
  );
}
