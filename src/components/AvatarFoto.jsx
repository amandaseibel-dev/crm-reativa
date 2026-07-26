import { useFotoPerfil } from "../utils/fotoPerfil";

// Avatar de foto de perfil (bucket privado). Recebe o USUARIO_ID (usuarios.id);
// a URL assinada de curta duração é resolvida no servidor pela Edge Function.
// Enquanto carrega, em falha ou sem foto, mostra a inicial do nome (fallback),
// nunca quebrando a tela. O cliente nunca manipula o caminho do objeto.
export function AvatarFoto({ usuarioId, nome, tamanho = 30, style }) {
  const url = useFotoPerfil(usuarioId);
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
