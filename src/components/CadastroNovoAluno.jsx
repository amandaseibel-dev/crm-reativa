import { useState } from "react";
import { supabase } from "../services/supabase";

function converterValor(valorDigitado) {
  let texto = String(valorDigitado || "")
    .replace("R$", "")
    .replace(/\s/g, "")
    .trim();

  if (!texto) return null;

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

  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : null;
}

const vazio = {
  nome: "",
  cpf: "",
  telefone: "",
  email: "",
  curso: "",
  valorEmAberto: "",
  observacao: "",
};

export default function CadastroNovoAluno() {
  const [aberto, setAberto] = useState(false);
  const [campos, setCampos] = useState(vazio);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");

  function atualizarCampo(nomeCampo, valor) {
    setCampos((anterior) => ({ ...anterior, [nomeCampo]: valor }));
  }

  async function identificarUsuario() {
    try {
      const { data } = await supabase.auth.getUser();
      const email = data?.user?.email || "";
      const nome =
        data?.user?.user_metadata?.nome ||
        data?.user?.user_metadata?.name ||
        email ||
        "Operador";

      return { email, nome };
    } catch {
      return { email: "", nome: "Operador" };
    }
  }

  async function cadastrarAluno() {
    setErro("");

    const nome = campos.nome.trim();
    const cpf = campos.cpf.trim();

    if (!nome) {
      setErro("Informe o nome do aluno.");
      return;
    }

    if (!cpf) {
      setErro("Informe o CPF do aluno (evita cadastro duplicado).");
      return;
    }

    setCarregando(true);

    const usuario = await identificarUsuario();
    const agora = new Date().toISOString();
    const valorEmAberto = converterValor(campos.valorEmAberto);

    // Verifica se já existe alguém com esse CPF antes de criar duplicado.
    const { data: existente, error: erroConsulta } = await supabase
      .from("alunos")
      .select("id, nome")
      .eq("cpf", cpf)
      .maybeSingle();

    if (erroConsulta) {
      console.error("Erro ao verificar CPF existente:", erroConsulta);
    }

    if (existente) {
      setCarregando(false);
      setErro(`Já existe um cadastro com esse CPF: ${existente.nome || "aluno sem nome"}. Abra a ficha dele em vez de criar um novo.`);
      return;
    }

    const { data: novoAluno, error } = await supabase
      .from("alunos")
      .insert({
        nome,
        cpf,
        telefone: campos.telefone.trim() || null,
        email: campos.email.trim() || null,
        curso: campos.curso.trim() || null,
        valor_em_aberto: valorEmAberto,
        status_jornada: "CONTATAR",
        status_atual: "CONTATAR",
        status_acionamento: "CONTATAR",
        proxima_acao: "CONTATAR",
        responsavel_atual_nome: usuario.nome,
        responsavel_atual_email: usuario.email,
        responsavel_atual_em: agora,
        registrado_por_nome: usuario.nome,
        registrado_por_email: usuario.email,
        registrado_em: agora,
        data_ultimo_acionamento: agora,
        criado_em: agora,
      })
      .select()
      .maybeSingle();

    if (error) {
      console.error("Erro ao cadastrar aluno:", error);
      setErro(
        "Não foi possível cadastrar o aluno: " + error.message +
          ". Se aparecer erro de coluna, me avise para eu ajustar."
      );
      setCarregando(false);
      return;
    }

    if (novoAluno?.id) {
      await supabase.from("aluno_movimentacoes").insert({
        aluno_id: String(novoAluno.id),
        tipo: "CADASTRO_NOVO_ALUNO",
        descricao:
          campos.observacao.trim() ||
          "Aluno cadastrado manualmente pelo operador (lead novo, sem estar em planilha).",
        status_anterior: null,
        status_novo: "CONTATAR",
        registrado_por_nome: usuario.nome,
        registrado_por_email: usuario.email,
        registrado_em: agora,
      });
    }

    setCarregando(false);
    setCampos(vazio);
    setAberto(false);

    alert("Aluno cadastrado com sucesso. Ele já entrou na sua fila.");
  }

  return (
    <>
      <button type="button" onClick={() => setAberto(true)} style={botaoAbrir}>
        + Cadastrar novo aluno
      </button>

      {aberto && (
        <div style={fundo}>
          <div style={modal}>
            <div style={cabecalho}>
              <div>
                <h2 style={titulo}>Cadastrar novo aluno</h2>
                <p style={subtitulo}>
                  Use aqui para leads/alunos que ainda não estão em nenhuma planilha ou base.
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setAberto(false);
                  setErro("");
                }}
                style={botaoFechar}
              >
                Fechar
              </button>
            </div>

            <div style={linha}>
              <div style={campo}>
                <label style={label}>Nome completo</label>
                <input
                  value={campos.nome}
                  onChange={(e) => atualizarCampo("nome", e.target.value)}
                  placeholder="Nome do aluno"
                  style={input}
                  autoFocus
                />
              </div>

              <div style={campo}>
                <label style={label}>CPF</label>
                <input
                  value={campos.cpf}
                  onChange={(e) => atualizarCampo("cpf", e.target.value)}
                  placeholder="Somente números"
                  style={input}
                />
              </div>
            </div>

            <div style={linha}>
              <div style={campo}>
                <label style={label}>Telefone</label>
                <input
                  value={campos.telefone}
                  onChange={(e) => atualizarCampo("telefone", e.target.value)}
                  placeholder="Ex: (11) 90000-0000"
                  style={input}
                />
              </div>

              <div style={campo}>
                <label style={label}>E-mail</label>
                <input
                  value={campos.email}
                  onChange={(e) => atualizarCampo("email", e.target.value)}
                  placeholder="E-mail do aluno"
                  style={input}
                />
              </div>
            </div>

            <div style={linha}>
              <div style={campo}>
                <label style={label}>Curso</label>
                <input
                  value={campos.curso}
                  onChange={(e) => atualizarCampo("curso", e.target.value)}
                  placeholder="Ex: Administração"
                  style={input}
                />
              </div>

              <div style={campo}>
                <label style={label}>Valor em aberto, se souber</label>
                <input
                  value={campos.valorEmAberto}
                  onChange={(e) => atualizarCampo("valorEmAberto", e.target.value)}
                  placeholder="Ex: 350,00"
                  style={input}
                />
              </div>
            </div>

            <label style={label}>Observação, se necessário</label>
            <textarea
              value={campos.observacao}
              onChange={(e) => atualizarCampo("observacao", e.target.value)}
              placeholder="Ex: lead recebido por indicação, ainda sem contrato"
              style={textarea}
            />

            {erro && <div style={erroBox}>{erro}</div>}

            <button
              type="button"
              onClick={cadastrarAluno}
              disabled={carregando}
              style={{
                ...botaoConfirmar,
                opacity: carregando ? 0.6 : 1,
                cursor: carregando ? "not-allowed" : "pointer",
              }}
            >
              {carregando ? "Cadastrando..." : "Cadastrar aluno"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const botaoAbrir = {
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "10px 14px",
  fontWeight: "900",
  cursor: "pointer",
};

const fundo = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.72)",
  zIndex: 99999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "20px",
};

const modal = {
  width: "min(760px, 96vw)",
  background: "#ffffff",
  borderRadius: "16px",
  padding: "20px",
  border: "3px solid #0f172a",
  boxShadow: "0 20px 80px rgba(0,0,0,0.35)",
  maxHeight: "90vh",
  overflowY: "auto",
};

const cabecalho = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  alignItems: "flex-start",
  marginBottom: "16px",
};

const titulo = {
  margin: 0,
  color: "#0f172a",
  fontSize: "22px",
  fontWeight: "900",
};

const subtitulo = {
  margin: "5px 0 0",
  color: "#475569",
  fontWeight: "700",
};

const linha = {
  display: "flex",
  gap: "12px",
  flexWrap: "wrap",
};

const campo = {
  flex: "1 1 220px",
};

const label = {
  display: "block",
  marginBottom: "5px",
  color: "#334155",
  fontWeight: "900",
  fontSize: "13px",
};

const input = {
  width: "100%",
  padding: "11px",
  border: "1px solid #cbd5e1",
  borderRadius: "9px",
  marginBottom: "12px",
  boxSizing: "border-box",
  fontSize: "15px",
};

const textarea = {
  ...input,
  minHeight: "80px",
  resize: "vertical",
};

const erroBox = {
  background: "#fee2e2",
  color: "#991b1b",
  padding: "11px",
  borderRadius: "9px",
  marginBottom: "12px",
  fontWeight: "900",
};

const botaoConfirmar = {
  width: "100%",
  background: "#16a34a",
  color: "#fff",
  border: "none",
  borderRadius: "10px",
  padding: "13px 16px",
  fontWeight: "900",
  fontSize: "15px",
};

const botaoFechar = {
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: "9px",
  padding: "9px 12px",
  fontWeight: "900",
  cursor: "pointer",
};
