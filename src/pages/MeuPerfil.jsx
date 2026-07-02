import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

export default function MeuPerfil() {
  const [usuarioAuth, setUsuarioAuth] = useState(null);
  const [perfil, setPerfil] = useState(null);
  const [apelido, setApelido] = useState("");
  const [aniversario, setAniversario] = useState("");
  const [fotoPreview, setFotoPreview] = useState("");
  const [arquivoFoto, setArquivoFoto] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [mensagem, setMensagem] = useState("");

  useEffect(() => {
    async function carregar() {
      const { data } = await supabase.auth.getSession();
      const email = data?.session?.user?.email;
      if (!email) return;

      setUsuarioAuth(data.session.user);

      const { data: dadosPerfil } = await supabase
        .from("usuarios")
        .select("*")
        .eq("email", email)
        .single();

      if (dadosPerfil) {
        setPerfil(dadosPerfil);
        setApelido(dadosPerfil.apelido || "");
        setAniversario(dadosPerfil.aniversario || "");
        setFotoPreview(dadosPerfil.foto_url || "");
      }
    }

    carregar();
  }, []);

  function selecionarFoto(e) {
    const arquivo = e.target.files?.[0];
    if (!arquivo) return;

    setArquivoFoto(arquivo);
    setFotoPreview(URL.createObjectURL(arquivo));
  }

  async function salvar() {
    if (!perfil) return;

    setSalvando(true);
    setMensagem("");

    try {
      let fotoUrl = perfil.foto_url || null;

      if (arquivoFoto) {
        const extensao = arquivoFoto.name.split(".").pop();
        const caminho = `${perfil.email}/${Date.now()}.${extensao}`;

        const { error: uploadError } = await supabase.storage
          .from("fotos-perfil")
          .upload(caminho, arquivoFoto, { cacheControl: "3600", upsert: true });

        if (uploadError) {
          setMensagem("Erro ao enviar foto: " + uploadError.message);
          setSalvando(false);
          return;
        }

        const { data: publicUrlData } = supabase.storage
          .from("fotos-perfil")
          .getPublicUrl(caminho);

        fotoUrl = publicUrlData?.publicUrl || fotoUrl;
      }

      const { error: updateError } = await supabase
        .from("usuarios")
        .update({
          apelido: apelido.trim() || null,
          foto_url: fotoUrl,
          aniversario: aniversario || null,
        })
        .eq("email", perfil.email);

      if (updateError) {
        setMensagem("Erro ao salvar: " + updateError.message);
        setSalvando(false);
        return;
      }

      setMensagem("Perfil atualizado! Atualizando a tela...");
      setTimeout(() => window.location.reload(), 900);
    } finally {
      setSalvando(false);
    }
  }

  if (!perfil) {
    return (
      <div className="main">
        <h1>Meu perfil</h1>
        <p>Carregando...</p>
      </div>
    );
  }

  return (
    <div className="main" style={{ maxWidth: 480 }}>
      <h1>Meu perfil</h1>
      <p style={{ opacity: 0.75, marginBottom: 20 }}>
        Personalize como seu nome e foto aparecem no CRM.
      </p>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginBottom: 20 }}>
        {fotoPreview ? (
          <img
            src={fotoPreview}
            alt="Foto de perfil"
            style={{ width: 96, height: 96, borderRadius: "50%", objectFit: "cover", border: "2px solid rgba(148,163,184,0.4)" }}
          />
        ) : (
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: "50%",
              background: "rgba(148,163,184,0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
            }}
          >
            {(perfil.apelido || perfil.nome || "?").charAt(0).toUpperCase()}
          </div>
        )}

        <label
          style={{
            padding: "6px 14px",
            borderRadius: 8,
            border: "1px solid rgba(148,163,184,0.4)",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Escolher foto
          <input type="file" accept="image/*" onChange={selecionarFoto} style={{ display: "none" }} />
        </label>
      </div>

      <label style={{ display: "block", marginBottom: 6, fontSize: 13, opacity: 0.85 }}>
        Nome completo (cadastro)
      </label>
      <input
        type="text"
        value={perfil.nome || ""}
        disabled
        style={{ width: "100%", padding: 10, borderRadius: 8, marginBottom: 16, opacity: 0.6 }}
      />

      <label style={{ display: "block", marginBottom: 6, fontSize: 13, opacity: 0.85 }}>
        Apelido (como quer ser chamado no CRM)
      </label>
      <input
        type="text"
        value={apelido}
        onChange={(e) => setApelido(e.target.value)}
        placeholder="Ex: Fê, Dieguinho, Ju..."
        maxLength={30}
        style={{ width: "100%", padding: 10, borderRadius: 8, marginBottom: 20 }}
      />

      <label style={{ display: "block", marginBottom: 6, fontSize: 13, opacity: 0.85 }}>
        Aniversário
      </label>
      <input
        type="date"
        value={aniversario}
        onChange={(e) => setAniversario(e.target.value)}
        style={{ width: "100%", padding: 10, borderRadius: 8, marginBottom: 20 }}
      />

      <button
        type="button"
        onClick={salvar}
        disabled={salvando}
        style={{
          padding: "10px 20px",
          borderRadius: 8,
          border: "1px solid rgba(34,197,94,0.6)",
          background: "rgba(34,197,94,0.16)",
          color: "#86efac",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {salvando ? "Salvando..." : "Salvar"}
      </button>

      {mensagem && <p style={{ marginTop: 12, fontSize: 13 }}>{mensagem}</p>}
    </div>
  );
}
