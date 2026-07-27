import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { urlComprovanteLink, enviarComprovanteLink } from "../utils/documentoFinanceiro";

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
    // Guarda de duplo clique: evita duas requisições simultâneas (o estado do
    // React pode não ter propagado para o `disabled` do botão ainda).
    if (enviando) return;

    if (!item?.id) {
      alert("Registro do link não localizado.");
      return;
    }

    if (!arquivo) {
      alert("Selecione o comprovante antes de anexar.");
      return;
    }

    setEnviando(true);

    // Upload autorizado pelo servidor: pede signed upload URL vinculada ao link,
    // sobe direto ao Storage e o servidor grava o caminho + auditoria. O cliente
    // nao escolhe bucket, pasta nem nome (UUID no servidor).
    const res = await enviarComprovanteLink(item.id, arquivo);

    // Sucesso idempotente: já estava vinculado. Não reenviar nem reprocessar
    // (não repetimos upload) e NÃO gravamos nada no banco. Orienta o operador
    // para a próxima etapa — o anexo não envia sozinho para a fila.
    if (res.ok && res.jaVinculado) {
      alert("Comprovante já anexado. Agora clique em ‘Enviar para confirmação’.");
      setArquivo(null);
      setEnviando(false);
      if (onAtualizar) onAtualizar();
      return;
    }

    if (!res.ok) {
      const msg =
        res.erro === "sessao_expirada"
          ? "Sessão expirada. Entre novamente."
          : res.erro === "ja_vinculado"
          ? "Comprovante já anexado. Agora clique em ‘Enviar para confirmação’."
          : res.erro === "mime_invalido"
          ? "Formato nao permitido. Envie PDF, PNG ou JPG."
          : res.erro === "tamanho_invalido"
          ? "Arquivo acima do limite (20 MB)."
          : res.erro === "acesso_negado"
          ? "Sem permissão para anexar comprovante neste registro."
          // Erro não reconhecido: não mascarar — mostra código e etapa (sem
          // CPF/nome/arquivo) para diagnóstico operacional.
          : `Falha ao anexar o comprovante (código: ${res.erro || "desconhecido"}${res.etapa ? `, etapa: ${res.etapa}` : ""}${res.status ? `, http: ${res.status}` : ""}).`;
      alert(msg);
      setEnviando(false);
      return;
    }

    // Nome do arquivo e campo de exibicao (nao faz parte do caminho).
    await supabase
      .from("links_pagamento")
      .update({ comprovante_nome: arquivo.name, atualizado_em: new Date().toISOString() })
      .eq("id", item.id);

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

      {/* Considera anexado quando há comprovante_url, mesmo sem comprovante_nome
          (registros antigos ficaram com nome NULL). Nome alternativo apenas para
          exibição — nada é gravado no banco. */}
      {temComprovante && (
        <p style={styles.arquivoAtual}>
          Arquivo atual: <strong>{item?.comprovante_nome || "Comprovante anexado"}</strong>
        </p>
      )}

      {/* Destaca a próxima etapa: o anexo NÃO cria a solicitação sozinho. */}
      {temComprovante && (
        <div style={styles.proximaEtapa}>
          Comprovante anexado. Agora clique em <strong>“Enviar para confirmação”</strong> para
          concluir o envio à fila.
        </div>
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
  proximaEtapa: {
    marginTop: "10px",
    padding: "10px 12px",
    background: "#ecfdf5",
    border: "1px solid #a7f3d0",
    borderRadius: "8px",
    color: "#065f46",
    fontSize: "13px",
  },
};
