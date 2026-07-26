import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { urlComprovanteLink } from "../utils/documentoFinanceiro";

export default function ComprovantePagamento({ item, onAtualizar }) {
  const [arquivo, setArquivo] = useState(null);
  const [enviando, setEnviando] = useState(false);
  // URL assinada de curta duração, obtida sob demanda via Edge Function pelo ID
  // seguro do link. Nunca persistida; renovada quando o item muda.
  const [visualizarUrl, setVisualizarUrl] = useState(null);

  const temComprovante = Boolean(item?.comprovante_url || item?.comprovante_nome);

  useEffect(() => {
    let ativo = true;
    // Busca a URL assinada de forma assíncrona. O render é guardado por
    // `temComprovante`, então um valor residual de outro item não aparece.
    if (item?.id && temComprovante) {
      urlComprovanteLink(item.id).then((u) => {
        if (ativo) setVisualizarUrl(u);
      });
    }
    return () => {
      ativo = false;
    };
  }, [item?.id, item?.comprovante_url, temComprovante]);

  async function anexarComprovante() {
    if (!item?.id) {
      alert("Registro do link não localizado.");
      return;
    }

    if (!arquivo) {
      alert("Selecione o comprovante antes de anexar.");
      return;
    }

    setEnviando(true);

    const { data: userData } = await supabase.auth.getUser();
    const usuario = userData?.user;

    const nomeSeguro = arquivo.name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9.\-_]/g, "_");

    const caminho = `${item.id}/${Date.now()}-${nomeSeguro}`;

    const { error: uploadError } = await supabase.storage
      .from("comprovantes-pagamento")
      .upload(caminho, arquivo, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      alert("Erro ao anexar comprovante: " + uploadError.message);
      setEnviando(false);
      return;
    }

    // Grava o CAMINHO INTERNO do objeto (bucket privado). A leitura é feita sob
    // demanda pela Edge Function via ID do link — sem URL pública permanente.
    const comprovanteUrl = caminho;

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        comprovante_url: comprovanteUrl,
        comprovante_nome: arquivo.name,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (error) {
      alert("Erro ao salvar comprovante no link: " + error.message);
      setEnviando(false);
      return;
    }

    await supabase.from("historico_links_pagamento").insert({
      link_pagamento_id: item.id,
      status_anterior: item.status,
      status_novo: item.status,
      observacao: `Comprovante anexado: ${arquivo.name}`,
      usuario_email: usuario?.email || "",
    });

    alert("Comprovante anexado com sucesso.");

    setArquivo(null);
    setEnviando(false);

    if (onAtualizar) onAtualizar();
  }

  return (
    <div style={styles.card}>
      <div style={styles.topo}>
        <div>
          <strong>Comprovante de pagamento</strong>
          <p style={styles.texto}>
            Anexe aqui o comprovante enviado pelo aluno.
          </p>
        </div>

        {temComprovante && visualizarUrl && (
          <a
            href={visualizarUrl}
            target="_blank"
            rel="noreferrer"
            style={styles.link}
          >
            Abrir comprovante
          </a>
        )}
        {temComprovante && !visualizarUrl && (
          <span style={{ ...styles.link, color: "#9ca3af", cursor: "default" }}>
            Carregando…
          </span>
        )}
      </div>

      {/* previewComprovante — usa a URL assinada de curta duração */}
      {temComprovante && visualizarUrl && (/(\.png|\.jpe?g)$/i.test(String(item.comprovante_nome || "")) ? (
        <img
          src={visualizarUrl}
          alt="comprovante"
          onClick={() => window.open(visualizarUrl, "_blank", "noreferrer")}
          title="Clique para abrir em tamanho grande, em outra aba"
          style={{
            maxWidth: "100%",
            maxHeight: 720,
            width: "auto",
            borderRadius: 8,
            border: "1px solid #e5e7eb",
            marginTop: 10,
            display: "block",
            cursor: "zoom-in",
          }}
        />
      ) : /\.pdf$/i.test(String(item.comprovante_nome || "")) ? (
        <iframe src={visualizarUrl} title="comprovante" style={{ width: "100%", height: 640, border: "1px solid #e5e7eb", borderRadius: 8, marginTop: 10 }} />
      ) : null)}

      {item?.comprovante_nome && (
        <p style={styles.arquivoAtual}>
          Arquivo atual: <strong>{item.comprovante_nome}</strong>
        </p>
      )}

      <div style={styles.linha}>
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
          onChange={(e) => setArquivo(e.target.files?.[0] || null)}
        />

        <button
          style={styles.botao}
          onClick={anexarComprovante}
          disabled={enviando}
        >
          {enviando ? "Anexando..." : "Anexar comprovante"}
        </button>
      </div>

      {arquivo && (
        <p style={styles.selecionado}>
          Selecionado: <strong>{arquivo.name}</strong>
        </p>
      )}
    </div>
  );
}

const styles = {
  card: {
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    padding: "12px",
    marginTop: "12px",
  },
  topo: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    alignItems: "flex-start",
  },
  texto: {
    margin: "4px 0 0 0",
    color: "#555",
    fontSize: "13px",
  },
  link: {
    color: "#0d6efd",
    fontWeight: "bold",
    whiteSpace: "nowrap",
  },
  arquivoAtual: {
    margin: "10px 0",
    color: "#374151",
  },
  linha: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
    alignItems: "center",
    marginTop: "10px",
  },
  botao: {
    background: "#198754",
    color: "#fff",
    border: "none",
    padding: "10px 14px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  selecionado: {
    margin: "8px 0 0 0",
    color: "#374151",
  },
};
