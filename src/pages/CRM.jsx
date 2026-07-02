import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { emailPorNomeOperador, nomeOperadorPorEmail, podeVerTudo } from "../utils/operadores";

/* ================= BASE ================= */

const OPERADORES = [
  { nome: "OLGA", email: "cobranca03@aelbra.com.br" },
  { nome: "ALLAN", email: "cobranca11@aelbra.com.br" },
  { nome: "DIEGO", email: "cobranca12@aelbra.com.br" },
  { nome: "RAFAELLA", email: "cobranca13@aelbra.com.br" },
  { nome: "MAURICIO", email: "cobranca06@aelbra.com.br" },
  { nome: "LUANA", email: "cobranca05@aelbra.com.br" },
  { nome: "NATALY", email: "cobranca08@aelbra.com.br" },
  { nome: "AMANDA", email: "cobranca07@aelbra.com.br" },
  { nome: "DANIELE", email: "cobranca10@aelbra.com.br" },
  { nome: "FERNANDA", email: "cobranca04@aelbra.com.br" },
  { nome: "JOÃO", email: "cobranca10@aelbra.com.br" },
];

const FILTROS = [
  "TODOS",
  "CRITICOS",
  "URGENTES",
  "ATENCAO",
  "NORMAL",
  "FINALIZADOS",
];

const STATUS_ATENDIMENTO = [
  "MENSAGEM_ENVIADA",
  "WHATSAPP_ENVIADO",
  "LIGACAO_REALIZADA",
  "SEM_RETORNO",
  "EM_TRATATIVA",
  "VALORES_ENVIADOS",
  "PROPOSTA_ENVIADA",
  "ACORDO_REALIZADO",
  "ACORDO_FECHADO",
  "NUMERO_INVALIDO",
  "SEM_TELEFONE",
  "SEM_INTERESSE",
  "QUITADO",
];

/* ================= COMPONENTE ================= */

export default function CRM() {

  // BLOQUEIO_FINAL_CRM_OPERADOR
  const [bloqueadoCRM, setBloqueadoCRM] = useState(false);
  const [verificandoCRM, setVerificandoCRM] = useState(true);

  useEffect(() => {
    async function bloquearOperadorNoCRM() {
      const { data } = await supabase.auth.getUser();
      const email = String(data?.user?.email || "").toLowerCase();

      const liberados = [
        "amanda.seibel@aelbra.com.br",
        "cobranca04@aelbra.com.br",
        "cobranca07@aelbra.com.br",
      ];

      if (!liberados.includes(email)) {
        setBloqueadoCRM(true);
      }

      setVerificandoCRM(false);
    }

    bloquearOperadorNoCRM();
  }, []);

  if (verificandoCRM) {
    return (
      <div style={{ padding: 40, color: "#fff", background: "#0f172a", minHeight: "100vh" }}>
        Verificando acesso...
      </div>
    );
  }

  if (bloqueadoCRM) {
    return (
      <div style={{ padding: 40, color: "#fff", background: "#0f172a", minHeight: "100vh" }}>
        <h1>🔒 CRM Operacional bloqueado para operador</h1>
        <p>Use a Fila Operacional / Minha Fila para atender seus alunos.</p>
        <button
          onClick={() => window.location.href = "/"}
          style={{
            background: "#22c55e",
            color: "#111827",
            border: "none",
            borderRadius: 12,
            padding: "12px 18px",
            fontWeight: 800,
            cursor: "pointer"
          }}
        >
          Ir para Minha Fila
        </button>
      </div>
    );
  }


  const [operador, setOperador] = useState("OLGA");
  const [usuario, setUsuario] = useState(null);
  const [perfilCarregado, setPerfilCarregado] = useState(false);
  const [busca, setBusca] = useState("");
  const [todosCasos, setTodosCasos] = useState([]);
  const [grupos, setGrupos] = useState([]);
  const [aberto, setAberto] = useState(null);
  const [filtro, setFiltro] = useState("TODOS");
  const [erro, setErro] = useState("");
  const [sucesso, setSucesso] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [historico, setHistorico] = useState({});
  const [observacoes, setObservacoes] = useState({});
  const [retornos, setRetornos] = useState({});
  const [horasRetorno, setHorasRetorno] = useState({});
  const [statusEditaveis, setStatusEditaveis] = useState({});
  const [transferencias, setTransferencias] = useState({});
  const [motivosTransferencia, setMotivosTransferencia] = useState({});

  const estiloCampo = {
    padding: 12,
    borderRadius: 10,
    border: "1px solid #6d28d9",
    background: "#ffffff",
    color: "#111827",
    fontWeight: 700,
  };

  const estiloBotao = {
    background: "#22c55e",
    color: "#020617",
    border: "none",
    borderRadius: 12,
    padding: "13px 22px",
    fontWeight: 900,
    cursor: "pointer",
    fontSize: 14,
  };

  const estiloBotaoSecundario = {
    background: "#a855f7",
    color: "#ffffff",
    border: "none",
    borderRadius: 12,
    padding: "13px 22px",
    fontWeight: 900,
    cursor: "pointer",
    fontSize: 14,
  };


  async function carregarUsuarioLogado() {
    const { data } = await supabase.auth.getUser();
    const user = data?.user || null;
    const email = user?.email || "";

    setUsuario(user);

    const ehAdm = podeVerTudo(email);

    if (!ehAdm) {
      const nomeOperador = nomeOperadorPorEmail(email);

      if (nomeOperador) {
        setOperador(nomeOperador);
      }
    }

    setPerfilCarregado(true);
  }

  function usuarioPodeVerTudo() {
    return podeVerTudo(usuario?.email || "");
  }

  function operadorDaSessao() {
    if (usuarioPodeVerTudo()) return operador;
    return nomeOperadorPorEmail(usuario?.email || "") || operador;
  }

  function normalizarTexto(t) {
    return String(t || "")
      .toUpperCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  function somenteNumeros(t) {
    return String(t || "").replace(/\D/g, "");
  }

  function hojeISO() {
    const hoje = new Date();
    const ano = hoje.getFullYear();
    const mes = String(hoje.getMonth() + 1).padStart(2, "0");
    const dia = String(hoje.getDate()).padStart(2, "0");
    return `${ano}-${mes}-${dia}`;
  }

  function dataParaComparar(valor) {
    if (!valor) return "";
    const texto = String(valor);

    if (/^\d{4}-\d{2}-\d{2}/.test(texto)) {
      return texto.slice(0, 10);
    }

    const data = new Date(valor);
    if (isNaN(data.getTime())) return "";

    const ano = data.getFullYear();
    const mes = String(data.getMonth() + 1).padStart(2, "0");
    const dia = String(data.getDate()).padStart(2, "0");

    return `${ano}-${mes}-${dia}`;
  }

  function formatarData(valor) {
    if (!valor) return "-";
    const data = new Date(valor);
    if (isNaN(data.getTime())) return valor;
    return data.toLocaleDateString("pt-BR");
  }

  function formatarDataHora(valor) {
    if (!valor) return "-";
    const data = new Date(valor);
    if (isNaN(data.getTime())) return valor;

    return data.toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    });
  }

  function dataParaInput(valor) {
    if (!valor) return "";
    const texto = String(valor);

    if (/^\d{4}-\d{2}-\d{2}/.test(texto)) {
      return texto.slice(0, 10);
    }

    const data = new Date(valor);
    if (isNaN(data.getTime())) return "";

    return data.toISOString().slice(0, 10);
  }

  function formatarHora(valor) {
    if (!valor) return "Sem horário";
    return String(valor).slice(0, 5);
  }

  function formatarMoeda(valor) {
    if (valor === null || valor === undefined || valor === "") return "-";

    const numero = Number(
      String(valor)
        .replace("R$", "")
        .replace(/\./g, "")
        .replace(",", ".")
        .trim()
    );

    if (isNaN(numero)) return String(valor);

    return numero.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  }

  function valorTexto(valor) {
    if (valor === null || valor === undefined || valor === "") return "-";
    return String(valor);
  }

  function normalizar(c) {
    return {
      id: c.id,
      casoCodigo: c.caso_codigo || "-",
      nome: c.nome || c.Nome || c.ALUNO || c.aluno || c.nome_aluno || "-",
      cpf: c.cpf_limpo || c.cpf || c.CPF || "-",
      cpfMascarado: c.cpf_mascarado || c.cpf_limpo || c.cpf || c.CPF || "-",
      cpfNumeros: somenteNumeros(c.cpf_limpo || c.cpf || c.CPF || ""),
      matricula: c.matricula || c.MATRICULA || c.ra || "-",
      operador: normalizarTexto(
        c.operador_base || c.operador || c.responsavel || ""
      ),
      operadorMensalidade: c.operador_mensalidade || "-",
      operadorAcordo: c.operador_acordo || c.operador_acordo_planilha || "-",
      criticidade: normalizarTexto(c.criticidade || c.prioridade || ""),
      urgencia: c.urgencia || "-",
      nivelCarteira: c.nivel_carteira || "-",
      slaOperacional: c.sla_operacional || "-",
      status: normalizarTexto(
        c.status_acionamento || c.status_atual || c.status || ""
      ),
      statusAtual: c.status_acionamento || c.status_atual || c.status || "SEM_STATUS",
      ultimoStatus:
        c.ultimo_status ||
        c.ultima_tabulacao ||
        c.status_acionamento ||
        c.status_atual ||
        c.status ||
        "SEM HISTÓRICO",
      statusFinanceiro: c.status_financeiro || "-",
      dataUltimoAcionamento: c.data_ultimo_acionamento || null,
      dataRetorno:
        c.data_retorno_nova ||
        c.data_retorno ||
        c.retorno_em ||
        c.proximo_retorno ||
        null,
      horaRetorno: c.hora_retorno || "",
      ultimaTabulacao: c.ultima_tabulacao_em || c.updated_at || null,
      totalEmAberto:
        c.total_em_aberto || c.valor_aberto || c.valor_total || c.valor || null,
      honorario: c.honorario || null,
      valorPago: c.valor_pago || null,
      mensalidadesEmAberto: c.mensalidades_em_aberto || "-",
      acordoEmAberto: c.acordo_em_aberto || "-",
      parcelaAVencer: c.parcela_a_vencer || "-",
      parcelasVencidas: c.parcelas_vencidas || "-",
      proximoVencimento:
        c.proximo_vencimento || c.vencimento || c.data_vencimento || null,
      diasAtraso: c.dias_atraso || "-",
      filaResponsavel: c.fila_responsavel || "-",
      observacoesBase: c.observacoes || c.observacao_financeira || "",
    };
  }

  function passaFiltro(c) {
    const st = c.status;
    const cr = c.criticidade;

    if (filtro === "TODOS") return true;
    if (filtro === "CRITICOS") return cr.includes("CRIT");
    if (filtro === "URGENTES") return cr.includes("URG");
    if (filtro === "ATENCAO") return cr.includes("ATEN");

    if (filtro === "NORMAL") {
      return !cr.includes("CRIT") && !cr.includes("URG") && !cr.includes("ATEN");
    }

    if (filtro === "FINALIZADOS") {
      
  // CRM_OPERADOR_BLOQUEADO_REATIVA
  const [usuarioBloqueadoCRM, setUsuarioBloqueadoCRM] = useState(false);

  useEffect(() => {
    async function verificarAcessoCRM() {
      const { data } = await supabase.auth.getUser();
      const email = String(data?.user?.email || "").toLowerCase();

      const podeVerCRM = [
        "amanda.seibel@aelbra.com.br",
        "cobranca04@aelbra.com.br",
        "cobranca07@aelbra.com.br",
      ].includes(email);

      setUsuarioBloqueadoCRM(!podeVerCRM);
    }

    verificarAcessoCRM();
  }, []);

  if (usuarioBloqueadoCRM) {
    return (
      <div style={{
        minHeight: "100vh",
        padding: "40px",
        background: "#0f172a",
        color: "#fff",
        fontFamily: "Inter, Arial, sans-serif"
      }}>
        <div style={{
          maxWidth: "760px",
          margin: "0 auto",
          background: "#111827",
          border: "1px solid #22c55e",
          borderRadius: "18px",
          padding: "28px"
        }}>
          <h1>🔒 CRM Operacional bloqueado para operador</h1>
          <p>
            A operação agora deve trabalhar pela Fila Operacional / Minha Fila.
            Esta tela fica disponível apenas para Amanda, Supervisão e Administrativo.
          </p>

          <button
            onClick={() => window.location.href = "/"}
            style={{
              marginTop: "18px",
              background: "#22c55e",
              color: "#0f172a",
              border: "none",
              borderRadius: "12px",
              padding: "12px 18px",
              fontWeight: 800,
              cursor: "pointer"
            }}
          >
            Ir para Minha Fila
          </button>
        </div>
      </div>
    );
  }

return (
        st.includes("QUITADO") ||
        st.includes("ACORDO") ||
        st.includes("ARQUIVAR") ||
        st.includes("FINALIZADO")
      );
    }

    return true;
  }

  function corCriticidade(criticidade) {
    const cr = normalizarTexto(criticidade);

    if (cr.includes("CRIT")) return "#ef4444";
    if (cr.includes("URG")) return "#f97316";
    if (cr.includes("ATEN")) return "#eab308";

    return "#22c55e";
  }

  function CardInfo({ titulo, valor, destaque }) {
    const vazio = valor === "-" || valor === null || valor === undefined || valor === "";

    return (
      <div
        style={{
          background: "#240044",
          border: "1px solid #7e22ce",
          borderRadius: 12,
          padding: 13,
          minHeight: 68,
          boxShadow: "0 0 0 1px rgba(168,85,247,0.12)",
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: 11,
            color: "#c4b5fd",
            fontWeight: 900,
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          {titulo}
        </p>

        <p
          style={{
            margin: "7px 0 0",
            fontSize: destaque ? 18 : 15,
            fontWeight: 900,
            color: destaque ? "#22c55e" : vazio ? "#e9d5ff" : "#ffffff",
          }}
        >
          {valor || "-"}
        </p>
      </div>
    );
  }

  function aplicarFiltros(lista) {
    let resultado = [...lista];

    if (busca.trim()) {
      const textoBusca = normalizarTexto(busca);
      const cpfBusca = somenteNumeros(busca);

      resultado = resultado.filter((c) => {
        const nome = normalizarTexto(c.nome);
        const matricula = normalizarTexto(c.matricula);

        return (
          nome.includes(textoBusca) ||
          c.cpfNumeros.includes(cpfBusca) ||
          matricula.includes(textoBusca)
        );
      });
    }

    return resultado.filter(passaFiltro);
  }

  function retornosHoje() {
    const hoje = hojeISO();

    return todosCasos
      .filter((c) => dataParaComparar(c.dataRetorno) === hoje)
      .sort((a, b) => {
        const horaA = a.horaRetorno || "99:99";
        const horaB = b.horaRetorno || "99:99";
        return horaA.localeCompare(horaB);
      });
  }

  async function buscar() {
    setErro("");
    setSucesso("");
    setCarregando(true);

    const { data, error } = await supabase
      .from("casos")
      .select("*")
      .eq("operador_base", operadorDaSessao())
      .range(0, 5000);

    setCarregando(false);

    if (error) {
      console.error(error);
      setErro("Erro ao carregar dados do CRM operacional.");
      return;
    }

    const resultadoNormalizado = (data || []).map(normalizar);

    setTodosCasos(resultadoNormalizado);
    setGrupos(aplicarFiltros(resultadoNormalizado));
  }

  async function carregarHistorico(casoId) {
    const { data, error } = await supabase
      .from("historico_casos")
      .select("*")
      .eq("caso_id", casoId)
      .order("criado_em", { ascending: false });

    if (error) {
      console.error(error);
      setErro("Erro ao carregar histórico do aluno.");
      return;
    }

    setHistorico((atual) => ({
      ...atual,
      [casoId]: data || [],
    }));
  }

  async function abrirCard(caso) {
    const novoAberto = aberto === caso.id ? null : caso.id;
    setAberto(novoAberto);

    if (novoAberto) {
      setRetornos((atual) => ({
        ...atual,
        [caso.id]: dataParaInput(caso.dataRetorno),
      }));

      setHorasRetorno((atual) => ({
        ...atual,
        [caso.id]: formatarHora(caso.horaRetorno) === "Sem horário" ? "" : formatarHora(caso.horaRetorno),
      }));

      setStatusEditaveis((atual) => ({
        ...atual,
        [caso.id]: caso.statusAtual,
      }));

      setObservacoes((atual) => ({
        ...atual,
        [caso.id]: atual[caso.id] || "",
      }));

      setTransferencias((atual) => ({
        ...atual,
        [caso.id]: caso.operador || operador,
      }));

      setMotivosTransferencia((atual) => ({
        ...atual,
        [caso.id]: atual[caso.id] || "",
      }));

      await carregarHistorico(caso.id);
    }
  }

  async function abrirPeloRetorno(caso) {
    setBusca("");
    setFiltro("TODOS");
    setGrupos(todosCasos);
    setAberto(caso.id);

    setRetornos((atual) => ({
      ...atual,
      [caso.id]: dataParaInput(caso.dataRetorno),
    }));

    setHorasRetorno((atual) => ({
      ...atual,
      [caso.id]: formatarHora(caso.horaRetorno) === "Sem horário" ? "" : formatarHora(caso.horaRetorno),
    }));

    setStatusEditaveis((atual) => ({
      ...atual,
      [caso.id]: caso.statusAtual,
    }));

    setObservacoes((atual) => ({
      ...atual,
      [caso.id]: atual[caso.id] || "",
    }));

    setTransferencias((atual) => ({
      ...atual,
      [caso.id]: caso.operador || operador,
    }));

    setMotivosTransferencia((atual) => ({
      ...atual,
      [caso.id]: atual[caso.id] || "",
    }));

    await carregarHistorico(caso.id);
  }

  async function registrarHistorico(caso, statusNovo, observacao, dataRetorno) {
    const { error } = await supabase.from("historico_casos").insert({
      caso_id: caso.id,
      operador: operadorDaSessao(),
      status_anterior: caso.statusAtual,
      status_novo: statusNovo,
      observacao: observacao,
      data_retorno: dataRetorno || null,
    });

    if (error) {
      console.error(error);
      setErro("A alteração foi salva, mas houve erro ao registrar o histórico.");
      return false;
    }

    return true;
  }

  async function salvarAtendimento(caso) {
    setErro("");
    setSucesso("");

    const novoStatus = statusEditaveis[caso.id] || caso.statusAtual;
    const novaObservacao = observacoes[caso.id] || "";
    const novaDataRetorno = retornos[caso.id] || null;
    const novaHoraRetorno = horasRetorno[caso.id] || null;

    const updateData = {
      status_acionamento: novoStatus,
      ultimo_status: caso.statusAtual,
      data_retorno: novaDataRetorno,
      data_retorno_nova: novaDataRetorno,
      hora_retorno: novaHoraRetorno,
      observacoes: novaObservacao,
      ultima_tabulacao_em: new Date().toISOString(),
      data_ultimo_acionamento: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("casos")
      .update(updateData)
      .eq("id", caso.id);

    if (error) {
      console.error(error);
      setErro("Erro ao salvar atendimento.");
      return;
    }

    const historicoOk = await registrarHistorico(
      caso,
      novoStatus,
      novaObservacao || "Atendimento atualizado manualmente.",
      novaDataRetorno
    );

    if (!historicoOk) return;

    setSucesso("Atendimento atualizado com sucesso.");
    await carregarHistorico(caso.id);
    buscar();
  }

  async function salvarAcao(caso, tipo) {
    setErro("");
    setSucesso("");

    const observacao = observacoes[caso.id] || "";
    const dataRetorno = retornos[caso.id] || dataParaInput(caso.dataRetorno) || null;
    const horaRetorno = horasRetorno[caso.id] || null;

    const updateData = {
      status_acionamento: tipo,
      ultimo_status: caso.statusAtual,
      observacoes: observacao,
      data_retorno: dataRetorno,
      data_retorno_nova: dataRetorno,
      hora_retorno: horaRetorno,
      ultima_tabulacao_em: new Date().toISOString(),
      data_ultimo_acionamento: new Date().toISOString(),
    };

    if (tipo === "QUITADO") {
      updateData.status_acionamento = "PENDENTE_VALIDACAO";
      updateData.fila_responsavel = "VALIDACAO_QUITACAO";
    }

    const { error: erroUpdate } = await supabase
      .from("casos")
      .update(updateData)
      .eq("id", caso.id);

    if (erroUpdate) {
      console.error(erroUpdate);
      setErro("Erro ao salvar ação.");
      return;
    }

    const historicoOk = await registrarHistorico(
      caso,
      updateData.status_acionamento,
      observacao,
      dataRetorno
    );

    if (!historicoOk) return;

    setObservacoes((atual) => ({
      ...atual,
      [caso.id]: "",
    }));

    setSucesso("Caso atualizado e histórico registrado com sucesso.");
    await carregarHistorico(caso.id);
    buscar();
  }


  function abrirAcoesAluno(c, acao) {
    const alunoSelecionado = {
      id: c.id,
      nome: c.nome,
      nome_aluno: c.nome,
      cpf: c.cpf,
      cpf_mascarado: c.cpfMascarado,
      matricula: c.matricula,
      valor_em_aberto: c.totalEmAberto,
      valor_total: c.totalEmAberto,
      status_financeiro: c.statusFinanceiro,
      operador: c.operador,
      data_retorno: c.dataRetorno,
      hora_retorno: c.horaRetorno,
      status_atual: c.statusAtual,
      observacao_operacional: c.observacoesBase,
    };

    localStorage.setItem("alunoSelecionado", JSON.stringify(alunoSelecionado));
    localStorage.setItem("acaoInicialAluno", acao);
    window.location.href = "/aluno";
  }

  async function transferirCaso(caso) {
    setErro("");
    setSucesso("");

    const novoOperador = transferencias[caso.id];
    const motivo = String(motivosTransferencia[caso.id] || "").trim();

    if (!novoOperador) {
      setErro("Selecione o operador de destino.");
      return;
    }

    if (novoOperador === caso.operador) {
      setErro("O caso já está com esse operador.");
      return;
    }

    if (!motivo) {
      setErro("Informe o motivo da transferência.");
      return;
    }

    const observacaoHistorico = `Caso transferido de ${caso.operador || operador} para ${novoOperador}. Motivo: ${motivo}`;

    const { error: erroUpdate } = await supabase
      .from("casos")
      .update({
        operador_base: novoOperador,
        ultimo_status: caso.statusAtual,
        ultima_tabulacao_em: new Date().toISOString(),
        data_ultimo_acionamento: new Date().toISOString(),
        observacoes: observacaoHistorico,
      })
      .eq("id", caso.id);

    if (erroUpdate) {
      console.error(erroUpdate);
      setErro("Erro ao transferir o caso.");
      return;
    }

    // Sincroniza com a tabela "alunos" (é o que a Fila Operacional / Minha
    // Fila realmente usa pra filtrar). Sem isso o caso "transferido" aqui
    // no CRM continua aparecendo na fila do operador antigo.
    if (caso.cpfNumeros) {
      const agora = new Date().toISOString();
      const vaiPraReceptivo = novoOperador === "RECEPTIVO";
      const emailNovoOperador = vaiPraReceptivo ? null : emailPorNomeOperador(novoOperador);

      if (vaiPraReceptivo || emailNovoOperador) {
        const nomeNovoOperador = vaiPraReceptivo
          ? "RECEPTIVO"
          : nomeOperadorPorEmail(emailNovoOperador);

        const { error: erroAluno } = await supabase
          .from("alunos")
          .update({
            responsavel_atual_nome: vaiPraReceptivo ? null : nomeNovoOperador,
            responsavel_atual_email: emailNovoOperador,
            responsavel_atual_em: agora,
            operador: novoOperador,
            operador_nome: vaiPraReceptivo ? null : nomeNovoOperador,
            operador_email: emailNovoOperador,
          })
          .eq("cpf", caso.cpfNumeros);

        if (erroAluno) {
          console.error("Erro ao sincronizar transferência com a fila do aluno:", erroAluno);
        }
      } else {
        console.warn(
          `Transferência pro operador "${novoOperador}" não sincronizada com a fila -- e-mail não encontrado no mapeamento canônico.`
        );
      }
    }

    const historicoOk = await registrarHistorico(
      caso,
      "TRANSFERENCIA_DE_CARTEIRA",
      observacaoHistorico,
      retornos[caso.id] || dataParaInput(caso.dataRetorno) || null
    );

    if (!historicoOk) return;

    setSucesso(`Caso transferido para ${novoOperador} com sucesso.`);
    setAberto(null);
    buscar();
  }

  useEffect(() => {
    carregarUsuarioLogado();
  }, []);

  useEffect(() => {
    if (perfilCarregado) {
      buscar();
    }
  }, [perfilCarregado, operador]);

  const listaRetornosHoje = retornosHoje();

  return (
    <div
      style={{
        padding: 24,
        background: "linear-gradient(180deg,#090014,#17002b)",
        minHeight: "100vh",
        color: "#fff",
      }}
    >
      <h2 style={{ color: "#c084fc", marginBottom: 18 }}>
        📞 CRM Operacional
      </h2>

      <div
        style={{
          background: "#1d0038",
          border: "1px solid #7e22ce",
          borderRadius: 16,
          padding: 16,
          marginBottom: 18,
          boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
        }}
      >
        <h3 style={{ margin: "0 0 12px", color: "#c084fc" }}>
          📅 Retornos de hoje
        </h3>

        {listaRetornosHoje.length > 0 ? (
          <div style={{ display: "grid", gap: 8 }}>
            {listaRetornosHoje.map((c) => (
              <div
                key={c.id}
                onClick={() => abrirPeloRetorno(c)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "90px 1fr 160px",
                  gap: 12,
                  alignItems: "center",
                  background: "#240044",
                  border: "1px solid #7e22ce",
                  borderRadius: 12,
                  padding: 12,
                  cursor: "pointer",
                }}
              >
                <strong style={{ color: "#22c55e", fontSize: 16 }}>
                  {formatarHora(c.horaRetorno)}
                </strong>

                <div>
                  <strong>{c.nome}</strong>
                  <p style={{ margin: "4px 0 0", color: "#c4b5fd", fontSize: 12 }}>
                    CPF: {c.cpfMascarado} | Matrícula: {c.matricula}
                  </p>
                </div>

                <span
                  style={{
                    background: corCriticidade(c.criticidade),
                    color: "#020617",
                    fontSize: 11,
                    fontWeight: 900,
                    padding: "5px 10px",
                    borderRadius: 999,
                    textAlign: "center",
                  }}
                >
                  {c.criticidade || "SEM CRITICIDADE"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: "#ddd6fe", margin: 0 }}>
            Nenhum retorno agendado para hoje nessa carteira.
          </p>
        )}
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          marginBottom: 20,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <select
          value={operadorDaSessao()}
          disabled={!usuarioPodeVerTudo()}
          onChange={(e) => {
            if (usuarioPodeVerTudo()) {
              setOperador(e.target.value);
            }
          }}
          style={{
            ...estiloCampo,
            opacity: usuarioPodeVerTudo() ? 1 : 0.75,
            cursor: usuarioPodeVerTudo() ? "pointer" : "not-allowed",
          }}
        >
          {OPERADORES.map((o) => (
            <option key={o.nome} value={o.nome}>
              {o.nome}
            </option>
          ))}
        </select>

        <select
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          style={estiloCampo}
        >
          {FILTROS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>

        <input
          placeholder="Nome, CPF ou matrícula"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          style={{ ...estiloCampo, minWidth: 300 }}
        />

        <button onClick={buscar} style={estiloBotao}>
          Buscar
        </button>
      </div>

      {!usuarioPodeVerTudo() && (
        <div
          style={{
            background: "#240044",
            border: "1px solid #7e22ce",
            borderRadius: 12,
            padding: 12,
            marginBottom: 16,
            color: "#ddd6fe",
            fontWeight: 800,
          }}
        >
          Você está visualizando sua fila de acionamentos. A pesquisa geral da base continua disponível nas telas de consulta/cadastro, mas a carteira ativa dos colegas não aparece aqui.
        </div>
      )}

      {carregando && <p>Carregando casos...</p>}
      {erro && <p style={{ color: "#f87171", fontWeight: 800 }}>{erro}</p>}
      {sucesso && <p style={{ color: "#22c55e", fontWeight: 800 }}>{sucesso}</p>}

      <p style={{ fontSize: 14, color: "#e9d5ff" }}>
        Total de casos encontrados: <strong>{grupos.length}</strong>
      </p>

      {grupos.map((c) => (
        <div
          key={c.id}
          style={{
            background: "#1d0038",
            marginBottom: 14,
            padding: 18,
            borderRadius: 16,
            border: "1px solid #7e22ce",
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
          }}
        >
          <div
            onClick={() => abrirCard(c)}
            style={{
              cursor: "pointer",
              display: "grid",
              gridTemplateColumns: "1.6fr 1fr 1fr 1fr",
              gap: 16,
              alignItems: "center",
            }}
          >
            <div>
              <span
                style={{
                  background: corCriticidade(c.criticidade),
                  color: "#020617",
                  fontSize: 11,
                  fontWeight: 900,
                  padding: "5px 10px",
                  borderRadius: 999,
                  display: "inline-block",
                  marginBottom: 8,
                }}
              >
                {c.criticidade || "SEM CRITICIDADE"}
              </span>

              <h3 style={{ margin: 0, fontSize: 19, color: "#ffffff" }}>
                {c.nome}
              </h3>

              <p style={{ fontSize: 13, color: "#c4b5fd", margin: "5px 0" }}>
                CPF: {c.cpfMascarado} | Matrícula: {c.matricula}
              </p>
            </div>

            <CardInfo titulo="Status atual" valor={c.statusAtual} />
            <CardInfo
              titulo="Valor em aberto"
              valor={formatarMoeda(c.totalEmAberto)}
              destaque
            />
            <CardInfo
              titulo="Retorno"
              valor={`${formatarData(c.dataRetorno)} ${c.horaRetorno ? `às ${formatarHora(c.horaRetorno)}` : ""}`}
            />
          </div>

          {aberto === c.id && (
            <div
              style={{
                marginTop: 18,
                paddingTop: 18,
                borderTop: "1px solid #7e22ce",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.15fr 0.85fr",
                  gap: 22,
                  alignItems: "start",
                }}
              >
                <div>
                  <h4 style={{ color: "#c084fc", margin: "0 0 12px", fontSize: 20 }}>
                    Ficha do aluno
                  </h4>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, 1fr)",
                      gap: 12,
                      marginBottom: 22,
                    }}
                  >
                    <CardInfo titulo="Operador" valor={c.operador} />
                    <CardInfo titulo="Dias atraso" valor={valorTexto(c.diasAtraso)} />
                    <CardInfo titulo="Nível carteira" valor={c.nivelCarteira} />
                    <CardInfo titulo="Urgência" valor={c.urgencia} />
                    <CardInfo titulo="SLA operacional" valor={c.slaOperacional} />
                    <CardInfo titulo="Fila responsável" valor={c.filaResponsavel} />
                  </div>

                  <div
                    style={{
                      background: "#240044",
                      border: "1px solid #7e22ce",
                      borderRadius: 12,
                      padding: 13,
                      marginBottom: 22,
                    }}
                  >
                    <p
                      style={{
                        margin: 0,
                        fontSize: 11,
                        color: "#c4b5fd",
                        fontWeight: 900,
                        textTransform: "uppercase",
                      }}
                    >
                      Transferência de carteira
                    </p>

                    <p style={{ margin: "7px 0 0", fontSize: 13, color: "#ddd6fe" }}>
                      Carteira atual: <strong>{c.operador || "-"}</strong>
                    </p>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 2fr auto",
                        gap: 10,
                        marginTop: 12,
                        alignItems: "center",
                      }}
                    >
                      <select
                        value={transferencias[c.id] || c.operador || operador}
                        onChange={(e) =>
                          setTransferencias((atual) => ({
                            ...atual,
                            [c.id]: e.target.value,
                          }))
                        }
                        style={{
                          padding: 11,
                          borderRadius: 8,
                          border: "1px solid #a855f7",
                          fontWeight: 800,
                        }}
                      >
                        {OPERADORES.map((op) => (
                          <option key={op.nome} value={op.nome}>
                            {op.nome}
                          </option>
                        ))}
                        <option value="RECEPTIVO">RECEPTIVO</option>
                      </select>

                      <input
                        placeholder="Motivo da transferência"
                        value={motivosTransferencia[c.id] || ""}
                        onChange={(e) =>
                          setMotivosTransferencia((atual) => ({
                            ...atual,
                            [c.id]: e.target.value,
                          }))
                        }
                        style={{
                          padding: 11,
                          borderRadius: 8,
                          border: "1px solid #a855f7",
                          fontWeight: 700,
                        }}
                      />

                      <button
                        style={estiloBotaoSecundario}
                        onClick={() => transferirCaso(c)}
                      >
                        Transferir
                      </button>
                    </div>
                  </div>

                  <h4 style={{ color: "#c084fc", margin: "0 0 12px", fontSize: 20 }}>
                    Financeiro resumido
                  </h4>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, 1fr)",
                      gap: 12,
                      marginBottom: 22,
                    }}
                  >
                    <CardInfo titulo="Total em aberto" valor={formatarMoeda(c.totalEmAberto)} destaque />
                    <CardInfo titulo="Honorário" valor={formatarMoeda(c.honorario)} />
                    <CardInfo titulo="Valor pago" valor={formatarMoeda(c.valorPago)} />
                    <CardInfo titulo="Mensalidades em aberto" valor={valorTexto(c.mensalidadesEmAberto)} />
                    <CardInfo titulo="Acordo em aberto" valor={valorTexto(c.acordoEmAberto)} />
                    <CardInfo titulo="Parcelas vencidas" valor={valorTexto(c.parcelasVencidas)} />
                    <CardInfo titulo="Parcela a vencer" valor={valorTexto(c.parcelaAVencer)} />
                    <CardInfo titulo="Próximo vencimento" valor={formatarData(c.proximoVencimento)} />
                    <CardInfo titulo="Status financeiro" valor={c.statusFinanceiro} />
                  </div>

                  <h4 style={{ color: "#c084fc", margin: "0 0 12px", fontSize: 20 }}>
                    Atendimento editável
                  </h4>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2, 1fr)",
                      gap: 12,
                      marginBottom: 14,
                    }}
                  >
                    <div
                      style={{
                        background: "#240044",
                        border: "1px solid #7e22ce",
                        borderRadius: 12,
                        padding: 13,
                      }}
                    >
                      <label
                        style={{
                          display: "block",
                          marginBottom: 7,
                          fontSize: 11,
                          color: "#c4b5fd",
                          fontWeight: 900,
                          textTransform: "uppercase",
                        }}
                      >
                        Status do atendimento
                      </label>

                      <select
                        value={statusEditaveis[c.id] || c.statusAtual}
                        onChange={(e) =>
                          setStatusEditaveis((atual) => ({
                            ...atual,
                            [c.id]: e.target.value,
                          }))
                        }
                        style={{
                          width: "100%",
                          padding: 10,
                          borderRadius: 8,
                          border: "1px solid #a855f7",
                          fontWeight: 800,
                        }}
                      >
                        {STATUS_ATENDIMENTO.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div
                      style={{
                        background: "#240044",
                        border: "1px solid #7e22ce",
                        borderRadius: 12,
                        padding: 13,
                      }}
                    >
                      <label
                        style={{
                          display: "block",
                          marginBottom: 7,
                          fontSize: 11,
                          color: "#c4b5fd",
                          fontWeight: 900,
                          textTransform: "uppercase",
                        }}
                      >
                        Data de retorno
                      </label>

                      <input
                        type="date"
                        value={retornos[c.id] || ""}
                        onChange={(e) =>
                          setRetornos((atual) => ({
                            ...atual,
                            [c.id]: e.target.value,
                          }))
                        }
                        style={{
                          width: "100%",
                          padding: 10,
                          borderRadius: 8,
                          border: "1px solid #a855f7",
                          fontWeight: 800,
                        }}
                      />
                    </div>

                    <div
                      style={{
                        background: "#240044",
                        border: "1px solid #7e22ce",
                        borderRadius: 12,
                        padding: 13,
                      }}
                    >
                      <label
                        style={{
                          display: "block",
                          marginBottom: 7,
                          fontSize: 11,
                          color: "#c4b5fd",
                          fontWeight: 900,
                          textTransform: "uppercase",
                        }}
                      >
                        Hora do retorno
                      </label>

                      <input
                        type="time"
                        value={horasRetorno[c.id] || ""}
                        onChange={(e) =>
                          setHorasRetorno((atual) => ({
                            ...atual,
                            [c.id]: e.target.value,
                          }))
                        }
                        style={{
                          width: "100%",
                          padding: 10,
                          borderRadius: 8,
                          border: "1px solid #a855f7",
                          fontWeight: 800,
                        }}
                      />
                    </div>

                    <CardInfo titulo="Última tabulação" valor={formatarData(c.ultimaTabulacao)} />
                    <CardInfo titulo="Último acionamento" valor={formatarData(c.dataUltimoAcionamento)} />
                  </div>

                  {c.observacoesBase && (
                    <div
                      style={{
                        background: "#240044",
                        border: "1px solid #7e22ce",
                        borderRadius: 12,
                        padding: 13,
                        marginBottom: 14,
                      }}
                    >
                      <p style={{ margin: 0, fontSize: 11, color: "#c4b5fd", fontWeight: 900 }}>
                        OBSERVAÇÃO ATUAL
                      </p>
                      <p style={{ margin: "7px 0 0", fontSize: 14 }}>
                        {c.observacoesBase}
                      </p>
                    </div>
                  )}

                  <textarea
                    placeholder="Observação do atendimento"
                    value={observacoes[c.id] || ""}
                    onChange={(e) =>
                      setObservacoes((atual) => ({
                        ...atual,
                        [c.id]: e.target.value,
                      }))
                    }
                    style={{
                      width: "100%",
                      minHeight: 90,
                      marginBottom: 14,
                      borderRadius: 12,
                      padding: 14,
                      fontSize: 15,
                      border: "2px solid #7e22ce",
                    }}
                  />

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      flexWrap: "wrap",
                      marginBottom: 18,
                    }}
                  >
                    <button style={estiloBotaoSecundario} onClick={() => salvarAtendimento(c)}>
                      Salvar retorno/observação
                    </button>

                    <button style={estiloBotao} onClick={() => salvarAcao(c, "WHATSAPP_ENVIADO")}>
                      WhatsApp enviado
                    </button>

                    <button style={estiloBotao} onClick={() => salvarAcao(c, "SEM_RETORNO")}>
                      Sem retorno
                    </button>

                    <button style={estiloBotao} onClick={() => salvarAcao(c, "EM_TRATATIVA")}>
                      Em tratativa
                    </button>

                    <button style={estiloBotao} onClick={() => salvarAcao(c, "ACORDO_REALIZADO")}>
                      Acordo realizado
                    </button>

                    <button style={estiloBotao} onClick={() => salvarAcao(c, "QUITADO")}>
                      Quitado
                    </button>

                    <button
                      style={{
                        ...estiloBotaoSecundario,
                        background: "#22c55e",
                        color: "#020617",
                      }}
                      onClick={() => abrirAcoesAluno(c, "LINK_PAGAMENTO")}
                    >
                      Solicitar link de pagamento
                    </button>

                    <button
                      style={{
                        ...estiloBotaoSecundario,
                        background: "#38bdf8",
                        color: "#020617",
                      }}
                      onClick={() => abrirAcoesAluno(c, "TERMO_ANEXO")}
                    >
                      Enviar termo/anexo
                    </button>

                  </div>
                </div>

                <div
                  style={{
                    background: "#140027",
                    border: "1px solid #7e22ce",
                    borderRadius: 14,
                    padding: 16,
                    minHeight: 280,
                  }}
                >
                  <h4 style={{ color: "#c084fc", margin: "0 0 14px", fontSize: 20 }}>
                    Timeline do aluno
                  </h4>

                  {historico[c.id] && historico[c.id].length > 0 ? (
                    historico[c.id].map((h) => (
                      <div
                        key={h.id}
                        style={{
                          borderLeft: "4px solid #c084fc",
                          paddingLeft: 14,
                          marginBottom: 18,
                        }}
                      >
                        <p style={{ fontSize: 12, margin: 0, color: "#c4b5fd", fontWeight: 800 }}>
                          {formatarDataHora(h.criado_em)} | Operador: {h.operador || "-"}
                        </p>

                        <p style={{ fontSize: 15, margin: "7px 0", fontWeight: 900 }}>
                          {h.status_novo || "-"}
                        </p>

                        <p style={{ fontSize: 12, margin: "7px 0", color: "#ddd6fe" }}>
                          Status anterior: {h.status_anterior || "-"}
                        </p>

                        {h.observacao && (
                          <p style={{ fontSize: 14, margin: "7px 0", color: "#ffffff" }}>
                            {h.observacao}
                          </p>
                        )}

                        {h.data_retorno && (
                          <p style={{ fontSize: 12, margin: "7px 0", color: "#ddd6fe" }}>
                            Retorno: {formatarData(h.data_retorno)}
                          </p>
                        )}
                      </div>
                    ))
                  ) : (
                    <p style={{ fontSize: 14, color: "#ddd6fe" }}>
                      Nenhum histórico registrado ainda para este aluno.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}

      {!carregando && grupos.length === 0 && (
        <p style={{ color: "#ddd6fe" }}>
          Nenhum caso encontrado para esse operador/filtro.
        </p>
      )}
    </div>
  );
}