import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

export default function PrioridadeLinksOperador() {
  const [links, setLinks] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    carregarPrioridades();

    const intervalo = setInterval(() => {
      carregarPrioridades();
    }, 25000);

    return () => clearInterval(intervalo);
  }, []);

  async function carregarPrioridades() {
    setCarregando(true);
    setErro("");

    const { data, error } = await supabase
      .from("vw_links_prioridade_operador")
      .select("*")
      .order("respondido_em", { ascending: true });

    setCarregando(false);

    if (error) {
      console.error("Erro ao carregar prioridade de links:", error);
      setErro("Não foi possível carregar os links prioritários.");
      return;
    }

    setLinks(data || []);
  }

  async function copiarTexto(texto) {
    try {
      await navigator.clipboard.writeText(texto || "");
      alert("Copiado com sucesso.");
    } catch (error) {
      console.error(error);
      alert("Não foi possível copiar automaticamente. Copie manualmente.");
    }
  }

  async function marcarComoEnviado(link) {
    const confirmar = window.confirm(
      `Confirmar que o link foi enviado ao aluno ${link.aluno_nome}?`
    );

    if (!confirmar) return;

    const { error } = await supabase
      .from("links_pagamento")
      .update({
        status: "LINK_ENVIADO_AO_ALUNO",
        enviado_operador_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString()
      })
      .eq("id", link.id);

    if (error) {
      console.error("Erro ao marcar link como enviado:", error);
      alert("Não foi possível marcar como enviado.");
      return;
    }

    await carregarPrioridades();
    alert("Link marcado como enviado ao aluno.");
  }

  function formatarMoeda(valor) {
    if (valor === null || valor === undefined || valor === "") return "-";

    return Number(valor).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL"
    });
  }

  function formatarData(data) {
    if (!data) return "-";

    const d = new Date(data);

    if (Number.isNaN(d.getTime())) return "-";

    return d.toLocaleString("pt-BR");
  }

  if (!carregando && links.length === 0) {
    return null;
  }

  return (
    <div style={container}>
      <style>
        {`
          @keyframes piscarRetornoLink {
            0% { box-shadow: 0 0 0px rgba(239, 68, 68, 0.2); }
            50% { box-shadow: 0 0 20px rgba(239, 68, 68, 0.9); }
            100% { box-shadow: 0 0 0px rgba(239, 68, 68, 0.2); }
          }
        `}
      </style>

      <div style={cabecalho}>
        <div>
          <h2 style={titulo}>⚠️ Retorno prioritário de link</h2>
          <p style={subtitulo}>
            Link gerado pelo ADM/Supervisão. Copie a mensagem pronta e envie ao aluno.
          </p>
        </div>

        <button type="button" onClick={carregarPrioridades} style={botaoAtualizar}>
          Atualizar
        </button>
      </div>

      {erro && <div style={erroBox}>{erro}</div>}

      {carregando && <p style={textoAuxiliar}>Carregando prioridades...</p>}

      {!carregando && links.map((link) => (
        <div key={link.id} style={card}>
          <div style={linhaTopo}>
            <div>
              <h3 style={nomeAluno}>{link.aluno_nome}</h3>
              <p style={detalhe}>
                CPF: {link.aluno_cpf || "-"} | Valor: {formatarMoeda(link.valor)} | Parcelas: {link.parcelas || 1}
              </p>
              <p style={detalhe}>
                Respondido em: {formatarData(link.respondido_em || link.atualizado_em)}
              </p>
            </div>

            <span style={badgePrioridade}>PRIORIDADE</span>
          </div>

          <label style={label}>Link de pagamento</label>
          <div style={linhaLink}>
            <input value={link.link_pagamento || ""} readOnly style={input} />

            <button
              type="button"
              onClick={() => copiarTexto(link.link_pagamento)}
              style={botaoCopiar}
            >
              Copiar link
            </button>
          </div>

          <label style={label}>Mensagem pronta</label>
          <textarea
            value={link.mensagem_pronta || ""}
            readOnly
            style={textarea}
          />

          <div style={linhaBotoes}>
            <button
              type="button"
              onClick={() => copiarTexto(link.mensagem_pronta)}
              style={botaoPrincipal}
            >
              Copiar mensagem pronta
            </button>

            <button
              type="button"
              onClick={() => marcarComoEnviado(link)}
              style={botaoConfirmar}
            >
              Marcar como enviado ao aluno
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

const container = {
  marginBottom: "18px",
  padding: "16px",
  borderRadius: "14px",
  border: "2px solid #ef4444",
  background: "#fff7ed",
  animation: "piscarRetornoLink 1.4s infinite"
};

const cabecalho = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  marginBottom: "12px"
};

const titulo = {
  margin: 0,
  color: "#991b1b",
  fontSize: "20px",
  fontWeight: "900"
};

const subtitulo = {
  margin: "4px 0 0",
  color: "#7c2d12",
  fontSize: "14px"
};

const botaoAtualizar = {
  background: "#7c2d12",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "9px 12px",
  fontWeight: "800",
  cursor: "pointer"
};

const erroBox = {
  background: "#fee2e2",
  color: "#991b1b",
  padding: "10px",
  borderRadius: "8px",
  fontWeight: "700",
  marginBottom: "10px"
};

const textoAuxiliar = {
  color: "#7c2d12",
  margin: 0
};

const card = {
  background: "#ffffff",
  border: "1px solid #fb923c",
  borderRadius: "12px",
  padding: "14px",
  marginTop: "12px"
};

const linhaTopo = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  alignItems: "flex-start"
};

const nomeAluno = {
  margin: 0,
  color: "#0f172a",
  fontSize: "18px",
  fontWeight: "900"
};

const detalhe = {
  margin: "4px 0",
  color: "#475569",
  fontSize: "13px"
};

const badgePrioridade = {
  background: "#dc2626",
  color: "#fff",
  borderRadius: "999px",
  padding: "6px 10px",
  fontSize: "12px",
  fontWeight: "900",
  whiteSpace: "nowrap"
};

const label = {
  display: "block",
  marginTop: "12px",
  marginBottom: "5px",
  color: "#334155",
  fontWeight: "800",
  fontSize: "13px"
};

const linhaLink = {
  display: "flex",
  gap: "8px"
};

const input = {
  width: "100%",
  padding: "10px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  fontSize: "14px",
  boxSizing: "border-box"
};

const textarea = {
  width: "100%",
  minHeight: "150px",
  padding: "10px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  fontSize: "14px",
  resize: "vertical",
  boxSizing: "border-box",
  whiteSpace: "pre-wrap"
};

const botaoCopiar = {
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "0 12px",
  fontWeight: "800",
  cursor: "pointer",
  whiteSpace: "nowrap"
};

const linhaBotoes = {
  display: "flex",
  gap: "10px",
  flexWrap: "wrap",
  marginTop: "12px"
};

const botaoPrincipal = {
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "10px 14px",
  fontWeight: "800",
  cursor: "pointer"
};

const botaoConfirmar = {
  background: "#16a34a",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "10px 14px",
  fontWeight: "800",
  cursor: "pointer"
};
