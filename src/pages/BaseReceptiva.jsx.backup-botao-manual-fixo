import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "../utils/operadores";

function pegarNome(aluno) {
  return aluno?.nome || aluno?.nome_aluno || aluno?.aluno || aluno?.nome_completo || aluno?.Nome || "-";
}

function pegarCpf(aluno) {
  return aluno?.cpf || aluno?.CPF || aluno?.cpf_mascarado || "-";
}

function pegarValor(aluno) {
  const valor =
    aluno?.valor_em_aberto ??
    aluno?.valor_aberto ??
    aluno?.valor_total ??
    aluno?.valor_divida ??
    aluno?.saldo_devedor ??
    aluno?.valor ??
    0;

  const numero = Number(String(valor).replace(",", "."));
  return Number.isFinite(numero) ? numero : 0;
}

function formatarValor(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function montarDataLocal(valor) {
  if (!valor) return null;

  if (typeof valor === "string" && valor.includes("-")) {
    const partes = valor.split("T")[0].split("-");
    if (partes.length === 3) {
      return new Date(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2]));
    }
  }

  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

function formatarData(valor) {
  const data = montarDataLocal(valor);
  if (!data) return "-";
  return data.toLocaleDateString("pt-BR");
}

function situacaoRetorno(aluno) {
  const data = montarDataLocal(aluno?.data_retorno);
  if (!data) return "SEM_RETORNO";

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  data.setHours(0, 0, 0, 0);

  if (data.getTime() < hoje.getTime()) return "ATRASADO";
  if (data.getTime() === hoje.getTime()) return "HOJE";
  return "FUTURO";
}

function textoRetorno(aluno) {
  if (!aluno?.data_retorno) return "Sem retorno";

  const hora = aluno?.hora_retorno ? ` às ${aluno.hora_retorno}` : "";
  const data = formatarData(aluno.data_retorno);
  const situacao = situacaoRetorno(aluno);

  if (situacao === "ATRASADO") return `Retorno atrasado: ${data}${hora}`;
  if (situacao === "HOJE") return `Retorno hoje: ${data}${hora}`;
  return `Retorno: ${data}${hora}`;
}

function estiloRetorno(aluno) {
  const situacao = situacaoRetorno(aluno);

  const base = {
    display: "inline-block",
    padding: "5px 9px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: "700",
  };

  if (situacao === "ATRASADO") {
    return { ...base, background: "#f8d7da", color: "#842029", border: "1px solid #f5c2c7" };
  }

  if (situacao === "HOJE") {
    return { ...base, background: "#fff3cd", color: "#664d03", border: "1px solid #ffecb5" };
  }

  if (situacao === "FUTURO") {
    return { ...base, background: "#d1e7dd", color: "#0f5132", border: "1px solid #badbcc" };
  }

  return { ...base, background: "#e5e7eb", color: "#374151", border: "1px solid #d1d5db" };
}

function casoReceptivo(aluno) {
  const operador = String(aluno?.operador_nome || aluno?.operador || aluno?.operador_email || "").trim().toUpperCase();
  const origem = String(aluno?.origem || aluno?.tipo_base || "").trim().toUpperCase();

  return (
    !operador ||
    operador === "RECEPTIVO" ||
    operador === "BASE RECEPTIVA" ||
    origem.includes("RECEPT")
  );
}

export default function BaseReceptiva() {
  const navigate = useNavigate();

  const [usuario, setUsuario] = useState(null);
  const [alunos, setAlunos] = useState([]);
  const [carregando, setCarregando] = useState(true);

  const [busca, setBusca] = useState("");
  const [filtroBase, setFiltroBase] = useState("RECEPTIVOS");
  const [filtroStatus, setFiltroStatus] = useState("TODOS");
  const [ordenacao, setOrdenacao] = useState("VALOR_DESC");

  const [statusAtendimento, setStatusAtendimento] = useState("Em tratativa");
  const [dataRetorno, setDataRetorno] = useState("");
  const [horaRetorno, setHoraRetorno] = useState("");
  const [observacao, setObservacao] = useState("");

  useEffect(() => {
    carregarUsuario();
    carregarAlunos();
  }, []);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarAlunos() {
    setCarregando(true);

    const { data, error } = await supabase
      .from("alunos")
      .select("*")
      .limit(1500);

    if (error) {
      alert("Erro ao carregar Base Receptiva: " + error.message);
      setCarregando(false);
      return;
    }

    setAlunos(data || []);
    setCarregando(false);
  }

  function abrirAluno(aluno) {
    localStorage.setItem("alunoSelecionado", JSON.stringify(aluno));
    navigate("/aluno");
  }

  async function assumirAtendimento(aluno) {
    const email = usuario?.email || "";
    const operadorNome = nomeOperadorPorEmail(email);

    if (!observacao.trim()) {
      alert("Informe uma observação antes de assumir o atendimento.");
      return;
    }

    const atualizacao = {
      operador_nome: operadorNome,
      operador_email: email,
      operador: operadorNome,
      status_jornada: statusAtendimento,
      data_retorno: dataRetorno || null,
      hora_retorno: horaRetorno || null,
      observacao,
      origem: "Base receptiva",
      tipo_base: "RECEPTIVA",
      atualizado_em: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("alunos")
      .update(atualizacao)
      .eq("id", aluno.id);

    if (error) {
      alert("Erro ao assumir atendimento: " + error.message);
      return;
    }

    await supabase.from("historico_atendimentos").insert({
      aluno_id: String(aluno.id),
      aluno_nome: pegarNome(aluno),
      aluno_cpf: pegarCpf(aluno),
      operador_nome: operadorNome,
      operador_email: email,
      status_jornada: statusAtendimento,
      data_retorno: dataRetorno || null,
      hora_retorno: horaRetorno || null,
      observacao,
      origem: "Base receptiva",
    });

    alert(`Caso assumido por ${operadorNome}. Ele passará a aparecer na fila operacional deste operador.`);

    setObservacao("");
    setDataRetorno("");
    setHoraRetorno("");

    carregarAlunos();
  }

  const alunosFiltrados = useMemo(() => {
    let lista = [...alunos];

    if (filtroBase === "RECEPTIVOS") {
      lista = lista.filter(casoReceptivo);
    }

    if (filtroStatus !== "TODOS") {
      lista = lista.filter((aluno) => String(aluno.status_jornada || "").toUpperCase() === filtroStatus);
    }

    if (busca.trim()) {
      const termo = busca.trim().toLowerCase();

      lista = lista.filter((aluno) => {
        const texto = [
          pegarNome(aluno),
          pegarCpf(aluno),
          aluno?.matricula,
          aluno?.email,
          aluno?.telefone,
          aluno?.curso,
        ]
          .join(" ")
          .toLowerCase();

        return texto.includes(termo);
      });
    }

    lista.sort((a, b) => {
      if (ordenacao === "VALOR_DESC") return pegarValor(b) - pegarValor(a);
      if (ordenacao === "VALOR_ASC") return pegarValor(a) - pegarValor(b);

      const da = montarDataLocal(a.data_retorno)?.getTime() || 9999999999999;
      const db = montarDataLocal(b.data_retorno)?.getTime() || 9999999999999;

      if (ordenacao === "RETORNO_ASC") return da - db;
      if (ordenacao === "RETORNO_DESC") return db - da;

      return pegarNome(a).localeCompare(pegarNome(b));
    });

    return lista;
  }, [alunos, busca, filtroBase, filtroStatus, ordenacao]);

  const statusDisponiveis = useMemo(() => {
    const status = new Set();

    alunos.forEach((aluno) => {
      if (aluno.status_jornada) status.add(String(aluno.status_jornada).toUpperCase());
    });

    return Array.from(status).sort();
  }, [alunos]);

  if (carregando) {
    return <div style={styles.container}>Carregando Base Receptiva...</div>;
  }

  return (
    <div style={styles.container}>
      <div style={styles.cabecalho}>
        <div>
          <h1 style={styles.titulo}>Base Receptiva</h1>
          <p style={styles.subtitulo}>
            Consulta geral para atendimento receptivo. Ao assumir, o caso entra na fila do operador logado.
          </p>
        </div>

        <div style={styles.nav}>
          <button style={styles.botaoEscuro} onClick={() => navigate("/fila-operacional")}>
            Fila Operacional
          </button>
          <button style={styles.botaoEscuro} onClick={() => navigate("/fila-adm-termos")}>
            Validação ADM
          </button>
        </div>
      </div>

      <div style={styles.card}>
        <h2 style={styles.subtituloCard}>Filtros</h2>

        <div style={styles.grid}>
          <input
            style={styles.input}
            placeholder="Buscar por nome, CPF, matrícula, telefone, curso..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />

          <select style={styles.input} value={filtroBase} onChange={(e) => setFiltroBase(e.target.value)}>
            <option value="RECEPTIVOS">Somente receptivos</option>
            <option value="TODOS">Todos os alunos</option>
          </select>

          <select style={styles.input} value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)}>
            <option value="TODOS">Todos os status</option>
            {statusDisponiveis.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>

          <select style={styles.input} value={ordenacao} onChange={(e) => setOrdenacao(e.target.value)}>
            <option value="VALOR_DESC">Maior valor primeiro</option>
            <option value="VALOR_ASC">Menor valor primeiro</option>
            <option value="RETORNO_ASC">Retorno crescente</option>
            <option value="RETORNO_DESC">Retorno decrescente</option>
            <option value="NOME_ASC">Nome A-Z</option>
          </select>
        </div>
      </div>

      <div style={styles.card}>
        <h2 style={styles.subtituloCard}>Assumir atendimento</h2>

        <div style={styles.grid}>
          <select
            style={styles.input}
            value={statusAtendimento}
            onChange={(e) => setStatusAtendimento(e.target.value)}
          >
            <option value="Em tratativa">Em tratativa</option>
            <option value="Retorno agendado">Retorno agendado</option>
            <option value="Sem retorno">Sem retorno</option>
            <option value="Acordo realizado">Acordo realizado</option>
            <option value="Termo enviado ADM">Termo enviado ADM</option>
          </select>

          <input
            style={styles.input}
            type="date"
            value={dataRetorno}
            onChange={(e) => setDataRetorno(e.target.value)}
          />

          <input
            style={styles.input}
            type="time"
            value={horaRetorno}
            onChange={(e) => setHoraRetorno(e.target.value)}
          />
        </div>

        <textarea
          style={styles.textarea}
          placeholder="Observação obrigatória para assumir atendimento..."
          value={observacao}
          onChange={(e) => setObservacao(e.target.value)}
        />
      </div>

      <div style={styles.resultado}>
        <strong>{alunosFiltrados.length}</strong> aluno(s) encontrados.
      </div>

      {alunosFiltrados.map((aluno) => (
        <div key={aluno.id} style={styles.linha}>
          <div>
            <h3 style={styles.nome}>{pegarNome(aluno)}</h3>
            <p style={styles.info}>CPF: {pegarCpf(aluno)}</p>
            <p style={styles.info}>Curso: {aluno.curso || "-"}</p>
            <p style={styles.info}>Status: {aluno.status_jornada || "-"}</p>
            <p style={styles.info}>Operador atual: {aluno.operador_nome || aluno.operador || "RECEPTIVO"}</p>
            <span style={estiloRetorno(aluno)}>{textoRetorno(aluno)}</span>
          </div>

          <div style={styles.acoes}>
            <div style={styles.valor}>{formatarValor(pegarValor(aluno))}</div>

            <button style={styles.botaoAzul} onClick={() => abrirAluno(aluno)}>
              Abrir ficha
            </button>

            <button style={styles.botaoVerde} onClick={() => assumirAtendimento(aluno)}>
              Assumir e salvar retorno
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    background: "#f4f6f8",
    padding: "24px",
    fontFamily: "Arial, sans-serif",
  },
  cabecalho: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "flex-start",
    marginBottom: "18px",
  },
  titulo: {
    margin: 0,
    color: "#111827",
  },
  subtitulo: {
    margin: "6px 0 0 0",
    color: "#555",
  },
  nav: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  },
  card: {
    background: "#fff",
    borderRadius: "14px",
    padding: "18px",
    marginBottom: "16px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  subtituloCard: {
    margin: "0 0 12px 0",
    color: "#111827",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "10px",
  },
  input: {
    padding: "11px",
    borderRadius: "8px",
    border: "1px solid #d1d5db",
    fontSize: "14px",
  },
  textarea: {
    width: "100%",
    minHeight: "80px",
    marginTop: "10px",
    padding: "11px",
    borderRadius: "8px",
    border: "1px solid #d1d5db",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
  },
  resultado: {
    margin: "14px 0",
    color: "#374151",
  },
  linha: {
    background: "#fff",
    borderRadius: "14px",
    padding: "16px",
    marginBottom: "12px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "flex-start",
  },
  nome: {
    margin: "0 0 6px 0",
    color: "#111827",
  },
  info: {
    margin: "4px 0",
    color: "#555",
  },
  acoes: {
    minWidth: "210px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    alignItems: "stretch",
  },
  valor: {
    fontSize: "18px",
    fontWeight: "bold",
    color: "#111827",
    textAlign: "right",
    marginBottom: "4px",
  },
  botaoAzul: {
    background: "#0d6efd",
    color: "#fff",
    border: "none",
    padding: "11px 14px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoVerde: {
    background: "#198754",
    color: "#fff",
    border: "none",
    padding: "11px 14px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoEscuro: {
    background: "#111827",
    color: "#fff",
    border: "none",
    padding: "10px 13px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
};
