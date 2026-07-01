import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

export default function ModuloLinkPagamentoGlobal() {
  const [aberto, setAberto] = useState(false);
  const [aluno, setAluno] = useState(null);
  const [valor, setValor] = useState("");
  const [parcelas, setParcelas] = useState(1);
  const [vencimento, setVencimento] = useState("");
  const [observacao, setObservacao] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    function abrir(evento) {
      const alunoRecebido = evento?.detail?.aluno || null;

      setAluno(alunoRecebido);
      setValor("");
      setParcelas(1);
      setVencimento("");
      setObservacao("");
      setErro("");
      setAberto(true);
    }

    window.addEventListener("REATIVA_ABRIR_LINK_PAGAMENTO", abrir);

    return () => {
      window.removeEventListener("REATIVA_ABRIR_LINK_PAGAMENTO", abrir);
    };
  }, []);

  function nomeAluno() {
    return (
      aluno?.nome ||
      aluno?.aluno_nome ||
      aluno?.nome_aluno ||
      aluno?.nome_completo ||
      aluno?.NOME ||
      aluno?.Nome ||
      ""
    );
  }

  function cpfAluno() {
    return (
      aluno?.cpf ||
      aluno?.aluno_cpf ||
      aluno?.documento ||
      aluno?.CPF ||
      ""
    );
  }

  function idAluno() {
    return (
      aluno?.id ||
      aluno?.aluno_id ||
      aluno?.ID ||
      cpfAluno() ||
      nomeAluno() ||
      null
    );
  }

  function converterValor(valorDigitado) {
    let texto = String(valorDigitado || "")
      .replace("R$", "")
      .replace(/\s/g, "")
      .trim();

    const temVirgula = texto.includes(",");
    const temPonto = texto.includes(".");

    if (temVirgula && temPonto) {
      // formato "1.500,00": ponto é milhar, vírgula é decimal
      texto = texto.replace(/\./g, "").replace(",", ".");
    } else if (temVirgula) {
      // só vírgula: ela é o separador decimal
      texto = texto.replace(",", ".");
    } else if (temPonto) {
      const partes = texto.split(".");
      const ultimaParte = partes[partes.length - 1];

      if (partes.length === 2 && ultimaParte.length === 2) {
        // ponto decimal, ex: "300.00" -> mantém como está
      } else {
        // ponto de milhar, ex: "1.500" -> remove os pontos
        texto = texto.replace(/\./g, "");
      }
    }

    return Number(texto);
  }

  async function identificarUsuario() {
    let email = "";
    let nome = "";

    try {
      const { data } = await supabase.auth.getUser();
      email = data?.user?.email || "";
      nome =
        data?.user?.user_metadata?.nome ||
        data?.user?.user_metadata?.name ||
        data?.user?.user_metadata?.full_name ||
        "";
    } catch {
      // ignora
    }

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const chave = localStorage.key(i);
        const texto = localStorage.getItem(chave);

        if (!texto) continue;

        if (!email) {
          const encontrado = texto.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
          if (encontrado?.[0]) email = encontrado[0];
        }

        if (!nome) {
          try {
            const json = JSON.parse(texto);
            nome =
              json?.nome ||
              json?.name ||
              json?.usuario_nome ||
              json?.operador_nome ||
              json?.full_name ||
              "";
          } catch {
            // ignora
          }
        }
      }
    } catch {
      // ignora
    }

    return {
      email,
      nome: nome || email || "Operador"
    };
  }

  async function confirmarSolicitacao() {
    setErro("");

    const nome = nomeAluno();
    const cpf = cpfAluno();
    const id = idAluno();
    const valorNumerico = converterValor(valor);

    if (!nome) {
      setErro("Aluno não identificado. Feche e selecione o aluno novamente.");
      return;
    }

    if (!valorNumerico || valorNumerico <= 0) {
      setErro("Informe o valor do link antes de enviar para ADM.");
      return;
    }

    if (!vencimento) {
      setErro("Informe o vencimento antes de enviar para ADM.");
      return;
    }

    setCarregando(true);

    const usuario = await identificarUsuario();

    const { error } = await supabase.rpc("solicitar_link_pagamento", {
      p_aluno_id: id ? String(id) : null,
      p_aluno_nome: nome,
      p_aluno_cpf: cpf || null,
      p_operador_solicitante: usuario.email || "",
      p_operador_nome: usuario.nome || usuario.email || "Operador",
      p_valor: valorNumerico,
      p_parcelas: Number(parcelas) || 1,
      p_data_vencimento: vencimento,
      p_observacao: observacao || null
    });

    setCarregando(false);

    if (error) {
      console.error("Erro ao solicitar link:", error);
      setErro(error.message || "Não foi possível solicitar o link.");
      return;
    }

    setAberto(false);

    alert("Link solicitado com dados preenchidos. Agora foi enviado para a fila ADM/Supervisão.");
  }

  if (!aberto) return null;

  return (
    <div style={fundo}>
      <div style={modal}>
        <div style={cabecalho}>
          <div>
            <h2 style={titulo}>Solicitar link de pagamento</h2>
            <p style={subtitulo}>
              Agora o link só vai para ADM depois de preencher valor, parcelas e vencimento.
            </p>
          </div>

          <button type="button" onClick={() => setAberto(false)} style={botaoFechar}>
            Fechar
          </button>
        </div>

        <div style={linha}>
          <div style={campo}>
            <label style={label}>Aluno</label>
            <input value={nomeAluno()} readOnly style={inputBloqueado} />
          </div>

          <div style={campo}>
            <label style={label}>CPF</label>
            <input value={cpfAluno()} readOnly style={inputBloqueado} />
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
              autoFocus
            />
          </div>

          <div style={campoMenor}>
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
              value={vencimento}
              onChange={(e) => setVencimento(e.target.value)}
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
          onClick={confirmarSolicitacao}
          disabled={carregando}
          style={{
            ...botaoConfirmar,
            opacity: carregando ? 0.6 : 1,
            cursor: carregando ? "not-allowed" : "pointer"
          }}
        >
          {carregando ? "Enviando para ADM..." : "Confirmar e enviar para ADM"}
        </button>
      </div>
    </div>
  );
}

const fundo = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.72)",
  zIndex: 99999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "20px"
};

const modal = {
  width: "min(760px, 96vw)",
  background: "#ffffff",
  borderRadius: "16px",
  padding: "20px",
  border: "3px solid #16a34a",
  boxShadow: "0 20px 80px rgba(0,0,0,0.35)"
};

const cabecalho = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  alignItems: "flex-start",
  marginBottom: "16px"
};

const titulo = {
  margin: 0,
  color: "#0f172a",
  fontSize: "22px",
  fontWeight: "900"
};

const subtitulo = {
  margin: "5px 0 0",
  color: "#475569",
  fontWeight: "700"
};

const linha = {
  display: "flex",
  gap: "12px",
  flexWrap: "wrap"
};

const campo = {
  flex: "1 1 220px"
};

const campoMenor = {
  flex: "0 1 120px"
};

const label = {
  display: "block",
  marginBottom: "5px",
  color: "#334155",
  fontWeight: "900",
  fontSize: "13px"
};

const input = {
  width: "100%",
  padding: "11px",
  border: "1px solid #cbd5e1",
  borderRadius: "9px",
  marginBottom: "12px",
  boxSizing: "border-box",
  fontSize: "15px"
};

const inputBloqueado = {
  ...input,
  background: "#e5e7eb",
  color: "#475569"
};

const textarea = {
  ...input,
  minHeight: "90px",
  resize: "vertical"
};

const erroBox = {
  background: "#fee2e2",
  color: "#991b1b",
  padding: "11px",
  borderRadius: "9px",
  marginBottom: "12px",
  fontWeight: "900"
};

const botaoConfirmar = {
  width: "100%",
  background: "#16a34a",
  color: "#fff",
  border: "none",
  borderRadius: "10px",
  padding: "13px 16px",
  fontWeight: "900",
  fontSize: "15px"
};

const botaoFechar = {
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: "9px",
  padding: "9px 12px",
  fontWeight: "900",
  cursor: "pointer"
};
