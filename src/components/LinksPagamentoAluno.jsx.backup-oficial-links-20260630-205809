import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

export default function LinksPagamentoAluno({
  aluno,
  alunoSelecionado,
  estudante,
  usuarioLogado,
  usuario,
  user,
  onSucesso,
  onAtualizar
}) {
  const alunoAtual = aluno || alunoSelecionado || estudante || {};
  const usuarioAtual = usuarioLogado || usuario || user || {};

  const [aberto, setAberto] = useState(false);
  const [valor, setValor] = useState("");
  const [parcelas, setParcelas] = useState(1);
  const [dataVencimento, setDataVencimento] = useState("");
  const [observacao, setObservacao] = useState("");
  const [linksAluno, setLinksAluno] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [carregandoLista, setCarregandoLista] = useState(false);
  const [erro, setErro] = useState("");

  const nomeAluno =
    alunoAtual?.nome ||
    alunoAtual?.aluno_nome ||
    alunoAtual?.nome_aluno ||
    alunoAtual?.NOME ||
    alunoAtual?.Nome ||
    "";

  const cpfAluno =
    alunoAtual?.cpf ||
    alunoAtual?.aluno_cpf ||
    alunoAtual?.CPF ||
    alunoAtual?.documento ||
    alunoAtual?.Documento ||
    "";

  const alunoId =
    alunoAtual?.id ||
    alunoAtual?.aluno_id ||
    alunoAtual?.ID ||
    cpfAluno ||
    nomeAluno ||
    null;

  useEffect(() => {
    carregarLinksAluno();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alunoId]);

  async function carregarLinksAluno() {
    if (!alunoId && !cpfAluno && !nomeAluno) return;

    setCarregandoLista(true);

    let query = supabase
      .from("links_pagamento")
      .select("*")
      .order("criado_em", { ascending: false });

    if (alunoId) {
      query = query.eq("aluno_id", String(alunoId));
    } else if (cpfAluno) {
      query = query.eq("aluno_cpf", cpfAluno);
    } else {
      query = query.eq("aluno_nome", nomeAluno);
    }

    const { data, error } = await query;

    setCarregandoLista(false);

    if (error) {
      console.error("Erro ao carregar links do aluno:", error);
      return;
    }

    setLinksAluno(data || []);
  }

  function converterValor(valorDigitado) {
    const texto = String(valorDigitado || "")
      .replace("R$", "")
      .replace(/\s/g, "")
      .replace(/\./g, "")
      .replace(",", ".");

    return Number(texto);
  }

  async function solicitarLink() {
    setErro("");

    if (!nomeAluno) {
      setErro("Nome do aluno não encontrado na ficha.");
      return;
    }

    if (!valor || converterValor(valor) <= 0) {
      setErro("Informe o valor do link.");
      return;
    }

    if (!dataVencimento) {
      setErro("Informe a data de vencimento do link.");
      return;
    }

    setCarregando(true);

    const payload = {
      aluno_id: alunoId ? String(alunoId) : null,
      aluno_nome: nomeAluno,
      aluno_cpf: cpfAluno || null,
      operador_solicitante:
        usuarioAtual?.email ||
        usuarioAtual?.nome ||
        usuarioAtual?.name ||
        "operador",
      operador_nome:
        usuarioAtual?.nome ||
        usuarioAtual?.name ||
        usuarioAtual?.email ||
        "Operador",
      valor: converterValor(valor),
      parcelas: Number(parcelas) || 1,
      data_vencimento: dataVencimento,
      observacao: observacao || null,
      status: "SOLICITADO_LINK"
    };

    const { error } = await supabase
      .from("links_pagamento")
      .insert(payload);

    setCarregando(false);

    if (error) {
      console.error("Erro ao solicitar link:", error);
      setErro("Não foi possível solicitar o link. Verifique os dados e tente novamente.");
      return;
    }

    setValor("");
    setParcelas(1);
    setDataVencimento("");
    setObservacao("");
    setAberto(false);

    await carregarLinksAluno();

    if (onSucesso) onSucesso();
    if (onAtualizar) onAtualizar();

    alert("Link solicitado com sucesso. Já foi enviado para a fila ADM/Supervisão.");
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

    const partes = String(data).split("-");
    if (partes.length === 3) {
      return `${partes[2]}/${partes[1]}/${partes[0]}`;
    }

    return data;
  }

  function corStatus(status) {
    if (status === "SOLICITADO_LINK") return "#f97316";
    if (status === "LINK_EM_ATENDIMENTO") return "#eab308";
    if (status === "LINK_GERADO") return "#2563eb";
    if (status === "LINK_RESPONDIDO") return "#2563eb";
    if (status === "LINK_PRONTO_PARA_ENVIO") return "#16a34a";
    if (status === "LINK_ENVIADO_AO_ALUNO") return "#15803d";
    if (status === "AGUARDANDO_BAIXA") return "#7c3aed";
    if (status === "BAIXA_REALIZADA") return "#047857";
    if (status === "BAIXA_DEVOLVIDA") return "#dc2626";
    return "#475569";
  }

  return (
    <div style={container}>
      <div style={cabecalho}>
        <div>
          <h3 style={titulo}>Links de pagamento</h3>
          <p style={subtitulo}>
            Solicite link em poucos cliques. Nome e CPF já vêm da ficha do aluno.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setAberto(!aberto)}
          style={botaoPrincipal}
        >
          {aberto ? "Fechar" : "Solicitar link"}
        </button>
      </div>

      {aberto && (
        <div style={formulario}>
          <div style={linha}>
            <div style={campoMetade}>
              <label style={label}>Aluno</label>
              <input value={nomeAluno} readOnly style={inputBloqueado} />
            </div>

            <div style={campoMetade}>
              <label style={label}>CPF</label>
              <input value={cpfAluno} readOnly style={inputBloqueado} />
            </div>
          </div>

          <div style={linha}>
            <div style={campoMetade}>
              <label style={label}>Valor do link</label>
              <input
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                placeholder="Ex: 350,00"
                style={input}
              />
            </div>

            <div style={campoMetade}>
              <label style={label}>Parcelas</label>
              <input
                type="number"
                min="1"
                value={parcelas}
                onChange={(e) => setParcelas(e.target.value)}
                style={input}
              />
            </div>
          </div>

          <label style={label}>Data de vencimento do link</label>
          <input
            type="date"
            value={dataVencimento}
            onChange={(e) => setDataVencimento(e.target.value)}
            style={input}
          />

          <label style={label}>Observação, se necessário</label>
          <textarea
            value={observacao}
            onChange={(e) => setObservacao(e.target.value)}
            placeholder="Ex: acordo referente às mensalidades em aberto"
            style={textarea}
          />

          {erro && <div style={erroBox}>{erro}</div>}

          <button
            type="button"
            onClick={solicitarLink}
            disabled={carregando}
            style={{
              ...botaoConfirmar,
              background: carregando ? "#94a3b8" : "#0f172a",
              cursor: carregando ? "not-allowed" : "pointer"
            }}
          >
            {carregando ? "Enviando para fila ADM..." : "Confirmar solicitação"}
          </button>
        </div>
      )}

      <div style={historico}>
        <h4 style={tituloHistorico}>Histórico de links deste aluno</h4>

        {carregandoLista && (
          <p style={textoVazio}>Carregando links...</p>
        )}

        {!carregandoLista && linksAluno.length === 0 && (
          <p style={textoVazio}>Nenhum link solicitado para este aluno ainda.</p>
        )}

        {!carregandoLista && linksAluno.map((link) => (
          <div key={link.id} style={itemHistorico}>
            <div style={linhaStatus}>
              <strong>{formatarMoeda(link.valor)}</strong>

              <span
                style={{
                  ...badge,
                  background: corStatus(link.status)
                }}
              >
                {link.status}
              </span>
            </div>

            <div style={detalhes}>
              <span>Parcelas: {link.parcelas || 1}</span>
              <span>Vencimento: {formatarData(link.data_vencimento)}</span>
            </div>

            {link.link_pagamento && (
              <div style={linkBox}>
                <input
                  value={link.link_pagamento}
                  readOnly
                  style={inputLink}
                />
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(link.link_pagamento)}
                  style={botaoCopiar}
                >
                  Copiar
                </button>
              </div>
            )}

            {link.mensagem_pronta && (
              <textarea
                value={link.mensagem_pronta}
                readOnly
                style={mensagemPronta}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const container = {
  marginTop: "16px",
  padding: "16px",
  border: "1px solid #d1d5db",
  borderRadius: "12px",
  background: "#ffffff"
};

const cabecalho = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "12px"
};

const titulo = {
  margin: 0,
  fontSize: "18px",
  fontWeight: "800",
  color: "#0f172a"
};

const subtitulo = {
  margin: "4px 0 0",
  color: "#64748b",
  fontSize: "13px"
};

const botaoPrincipal = {
  background: "#16a34a",
  color: "#fff",
  border: "none",
  padding: "10px 14px",
  borderRadius: "8px",
  fontWeight: "800",
  cursor: "pointer",
  whiteSpace: "nowrap"
};

const formulario = {
  marginTop: "14px",
  padding: "14px",
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  background: "#f8fafc"
};

const linha = {
  display: "flex",
  gap: "12px",
  flexWrap: "wrap"
};

const campoMetade = {
  flex: "1 1 220px"
};

const label = {
  display: "block",
  fontSize: "13px",
  fontWeight: "700",
  color: "#334155",
  marginBottom: "5px"
};

const input = {
  width: "100%",
  padding: "10px",
  marginBottom: "12px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  fontSize: "14px",
  boxSizing: "border-box"
};

const inputBloqueado = {
  ...input,
  background: "#e5e7eb",
  color: "#475569"
};

const textarea = {
  ...input,
  minHeight: "78px",
  resize: "vertical"
};

const erroBox = {
  background: "#fee2e2",
  color: "#991b1b",
  padding: "10px",
  borderRadius: "8px",
  marginBottom: "10px",
  fontWeight: "700"
};

const botaoConfirmar = {
  color: "#fff",
  border: "none",
  padding: "11px 16px",
  borderRadius: "8px",
  fontWeight: "800",
  width: "100%"
};

const historico = {
  marginTop: "16px"
};

const tituloHistorico = {
  margin: "0 0 10px",
  color: "#0f172a"
};

const textoVazio = {
  color: "#64748b",
  fontSize: "14px",
  margin: 0
};

const itemHistorico = {
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  padding: "12px",
  marginBottom: "10px",
  background: "#ffffff"
};

const linhaStatus = {
  display: "flex",
  justifyContent: "space-between",
  gap: "10px",
  alignItems: "center"
};

const badge = {
  color: "#fff",
  borderRadius: "999px",
  padding: "4px 9px",
  fontSize: "11px",
  fontWeight: "800"
};

const detalhes = {
  display: "flex",
  gap: "12px",
  flexWrap: "wrap",
  color: "#64748b",
  fontSize: "13px",
  marginTop: "8px"
};

const linkBox = {
  display: "flex",
  gap: "8px",
  marginTop: "10px"
};

const inputLink = {
  flex: 1,
  padding: "9px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px"
};

const botaoCopiar = {
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "0 12px",
  fontWeight: "800",
  cursor: "pointer"
};

const mensagemPronta = {
  width: "100%",
  marginTop: "10px",
  minHeight: "120px",
  padding: "10px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  resize: "vertical",
  boxSizing: "border-box"
};