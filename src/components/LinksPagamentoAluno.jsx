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
  const [historico, setHistorico] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");

  const nomeAluno =
    alunoAtual?.nome ||
    alunoAtual?.aluno_nome ||
    alunoAtual?.nome_aluno ||
    alunoAtual?.nome_completo ||
    alunoAtual?.NOME ||
    alunoAtual?.Nome ||
    "";

  const cpfAluno =
    alunoAtual?.cpf ||
    alunoAtual?.aluno_cpf ||
    alunoAtual?.documento ||
    alunoAtual?.CPF ||
    "";

  const alunoId =
    alunoAtual?.id ||
    alunoAtual?.aluno_id ||
    alunoAtual?.ID ||
    cpfAluno ||
    nomeAluno ||
    null;

  useEffect(() => {
    carregarHistorico();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alunoId, cpfAluno, nomeAluno]);

  function converterValor(valorDigitado) {
    return Number(
      String(valorDigitado || "")
        .replace("R$", "")
        .replace(/\s/g, "")
        .replace(/\./g, "")
        .replace(",", ".")
    );
  }

  async function carregarHistorico() {
    if (!alunoId && !cpfAluno && !nomeAluno) return;

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

    if (!error) {
      setHistorico(data || []);
    }
  }

  async function solicitarLink() {
    setErro("");

    if (!nomeAluno) {
      setErro("Aluno não identificado na ficha.");
      return;
    }

    const valorNumerico = converterValor(valor);

    if (!valorNumerico || valorNumerico <= 0) {
      setErro("Informe o valor do link.");
      return;
    }

    if (!dataVencimento) {
      setErro("Informe a data de vencimento do link.");
      return;
    }

    setCarregando(true);

    const { error } = await supabase.rpc("solicitar_link_pagamento", {
      p_aluno_id: alunoId ? String(alunoId) : null,
      p_aluno_nome: nomeAluno,
      p_aluno_cpf: cpfAluno || null,
      p_operador_solicitante:
        usuarioAtual?.email ||
        usuarioAtual?.nome ||
        usuarioAtual?.name ||
        "operador",
      p_operador_nome:
        usuarioAtual?.nome ||
        usuarioAtual?.name ||
        usuarioAtual?.email ||
        "Operador",
      p_valor: valorNumerico,
      p_parcelas: Number(parcelas) || 1,
      p_data_vencimento: dataVencimento,
      p_observacao: observacao || null
    });

    setCarregando(false);

    if (error) {
      console.error("Erro ao solicitar link:", error);
      setErro(error.message || "Não foi possível solicitar o link.");
      return;
    }

    setValor("");
    setParcelas(1);
    setDataVencimento("");
    setObservacao("");
    setAberto(false);

    await carregarHistorico();

    if (onSucesso) onSucesso();
    if (onAtualizar) onAtualizar();

    alert("Link solicitado com sucesso. Foi enviado para a fila ADM/Supervisão.");
  }

  function formatarMoeda(numero) {
    if (numero === null || numero === undefined || numero === "") return "-";
    return Number(numero).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL"
    });
  }

  function formatarData(data) {
    if (!data) return "-";
    const texto = String(data);
    const partes = texto.split("-");
    if (partes.length >= 3) {
      return `${partes[2].slice(0, 2)}/${partes[1]}/${partes[0]}`;
    }
    return texto;
  }

  return (
    <div style={container}>
      <div style={cabecalho}>
        <div>
          <h3 style={titulo}>Links de pagamento</h3>
          <p style={subtitulo}>
            Solicite o link com valor, parcelas e vencimento. Sem pop-up e sem envio vazio.
          </p>
        </div>

        <button type="button" onClick={() => setAberto(!aberto)} style={botaoPrincipal}>
          {aberto ? "Fechar" : "Solicitar link"}
        </button>
      </div>

      {aberto && (
        <div style={formulario}>
          <div style={linha}>
            <div style={campo}>
              <label style={label}>Aluno</label>
              <input value={nomeAluno} readOnly style={inputBloqueado} />
            </div>

            <div style={campo}>
              <label style={label}>CPF</label>
              <input value={cpfAluno} readOnly style={inputBloqueado} />
            </div>
          </div>

          <div style={linha}>
            <div style={campo}>
              <label style={label}>Valor do link</label>
              <input
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                placeholder="Ex: 350,00"
                style={input}
              />
            </div>

            <div style={campo}>
              <label style={label}>Parcelas</label>
              <input
                type="number"
                min="1"
                value={parcelas}
                onChange={(e) => setParcelas(e.target.value)}
                style={input}
              />
            </div>

            <div style={campo}>
              <label style={label}>Vencimento</label>
              <input
                type="date"
                value={dataVencimento}
                onChange={(e) => setDataVencimento(e.target.value)}
                style={input}
              />
            </div>
          </div>

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
              opacity: carregando ? 0.6 : 1,
              cursor: carregando ? "not-allowed" : "pointer"
            }}
          >
            {carregando ? "Enviando..." : "Confirmar solicitação"}
          </button>
        </div>
      )}

      {historico.length > 0 && (
        <div style={historicoBox}>
          <h4 style={tituloHistorico}>Histórico de links</h4>

          {historico.map((item) => (
            <div key={item.id} style={historicoItem}>
              <strong>{item.status}</strong>
              <span>{formatarMoeda(item.valor)}</span>
              <span>Parcelas: {item.parcelas || 1}</span>
              <span>Vencimento: {formatarData(item.data_vencimento)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const container = {
  marginTop: "16px",
  padding: "16px",
  border: "1px solid #d1d5db",
  borderRadius: "12px",
  background: "#fff"
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
  color: "#0f172a",
  fontWeight: "900"
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
  borderRadius: "8px",
  padding: "10px 14px",
  fontWeight: "900",
  cursor: "pointer"
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

const campo = {
  flex: "1 1 180px"
};

const label = {
  display: "block",
  marginBottom: "5px",
  color: "#334155",
  fontWeight: "800",
  fontSize: "13px"
};

const input = {
  width: "100%",
  padding: "10px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  marginBottom: "12px",
  boxSizing: "border-box"
};

const inputBloqueado = {
  ...input,
  background: "#e5e7eb",
  color: "#475569"
};

const textarea = {
  ...input,
  minHeight: "80px",
  resize: "vertical"
};

const erroBox = {
  background: "#fee2e2",
  color: "#991b1b",
  padding: "10px",
  borderRadius: "8px",
  marginBottom: "10px",
  fontWeight: "800"
};

const botaoConfirmar = {
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "11px 16px",
  fontWeight: "900",
  width: "100%"
};

const historicoBox = {
  marginTop: "14px"
};

const tituloHistorico = {
  margin: "0 0 8px",
  color: "#0f172a"
};

const historicoItem = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
  padding: "10px",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  marginBottom: "8px",
  color: "#334155",
  fontSize: "13px"
};
