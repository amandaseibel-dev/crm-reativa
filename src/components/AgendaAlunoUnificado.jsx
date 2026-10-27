import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "../utils/operadores";

const STATUS = {
  EM_COBRANCA: "Em cobrança",
  RETORNO_AGENDADO: "Retorno agendado",
  EM_NEGOCIACAO: "Em negociação",
  AGUARDANDO_LINK: "Aguardando link",
  AGUARDANDO_TERMO: "Aguardando termo",
  PAGAMENTO_IDENTIFICADO: "Pagamento identificado",
  REVISAR_UNIFICACAO: "Revisar unificação",
  NAO_CONTATAR: "Não contatar",
  QUITADO: "Quitado",
};

const PRIORIDADE = {
  NORMAL: "Normal",
  ALTA: "Alta",
  CRITICO: "Crítico",
};

function dataHoraBR(valor) {
  if (!valor) return "Nunca";
  try {
    return new Date(valor).toLocaleString("pt-BR");
  } catch {
    return "Nunca";
  }
}

function calcularDiasSemContato(valor) {
  if (!valor) return null;

  const hoje = new Date();
  const data = new Date(valor);
  const diff = hoje.getTime() - data.getTime();

  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

export default function AgendaAlunoUnificado({ aluno, onAtualizar }) {
  const [usuario, setUsuario] = useState(null);
  const [salvando, setSalvando] = useState(false);

  const [form, setForm] = useState({
    operador_nome: "",
    operador_email: "",
    status_jornada: "EM_COBRANCA",
    prioridade_operacional: "NORMAL",
    observacao_operacional: "",
  });

  useEffect(() => {
    carregarUsuario();
  }, []);

  useEffect(() => {
    if (!aluno) return;

    setForm({
      operador_nome: aluno.operador_nome || "",
      operador_email: aluno.operador_email || "",
      status_jornada: aluno.status_jornada || "EM_COBRANCA",
      prioridade_operacional: aluno.prioridade_operacional || "NORMAL",
      observacao_operacional: aluno.observacao_operacional || "",
    });
  }, [aluno]);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function salvarAgenda() {
    if (!aluno?.chave_unificacao) {
      alert("Chave de unificação não localizada.");
      return;
    }

    setSalvando(true);

    const email = usuario?.email || "";
    const nome = nomeOperadorPorEmail(email);

    const operadorEmailFinal = form.operador_email || email;
    const operadorNomeFinal = form.operador_nome || nome;

    // ESTE COMPONENTE NÃO GRAVA RETORNO (27/10/2026). Duas razões:
    //
    // 1. `alunos_unificados` é ESPELHO. O gatilho
    //    `trg_sincronizar_alunos_unificados`, em `public.alunos`, copia
    //    `data_retorno`, `hora_retorno` e `retorno_origem` para cá casando por
    //    `chave_unificacao`. Gravar aqui punha a data no lugar errado, sem
    //    carimbo de origem, e a próxima mudança da ficha desfazia.
    // 2. A fonte seria `public.alunos` -- mas a agenda é escopada pelo DONO DO
    //    CASO (`responsavel_atual_email`), e não pelo `operador_email` do
    //    cadastro unificado; foi essa mistura que tirou a Agenda Operacional do
    //    ar em 28/08/2026 (`docs/PREMISSAS.md` §11). E uma `chave_unificacao`
    //    pode ter DUAS fichas em `alunos` (176 chaves, máximo 2, medido em
    //    27/10/2026), então escrever por chave mexeria em caso de outra pessoa.
    //
    // Como este componente não tem nenhum chamador em `src` hoje, a saída
    // honesta é não ter caminho de escrita de retorno em vez de inventar um que
    // ninguém exercita. Quem for reativar a tela: escrever em `public.alunos`
    // pelo `id` da ficha dona do caso, via `camposDeRetorno`, conferindo
    // quantas linhas foram afetadas. A data e a hora continuam VISÍVEIS no topo
    // (leitura do espelho), e o formulário não as oferece mais para edição.
    const { error } = await supabase
      .from("alunos_unificados")
      .update({
        operador_nome: operadorNomeFinal,
        operador_email: operadorEmailFinal,
        status_jornada: form.status_jornada || "EM_COBRANCA",
        prioridade_operacional: form.prioridade_operacional || "NORMAL",
        observacao_operacional: form.observacao_operacional || null,
        ultima_interacao_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq("chave_unificacao", aluno.chave_unificacao);

    setSalvando(false);

    if (error) {
      alert("Erro ao salvar agenda do aluno: " + error.message);
      return;
    }

    alert("Agenda / próxima ação salva no cadastro do aluno.");

    if (onAtualizar) onAtualizar();
  }

  const diasSemContato = calcularDiasSemContato(aluno?.ultima_interacao_em);

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.titulo}>Agenda / Próxima Ação</h2>
          <p style={styles.texto}>
            Esse registro fica salvo no cadastro unificado do aluno e alimenta a Agenda Operacional.
          </p>
        </div>

        <div style={styles.statusBox}>
          <span>Último contato</span>
          <strong>
            {diasSemContato === null ? "Nunca" : `Há ${diasSemContato} dia(s)`}
          </strong>
        </div>
      </div>

      <div style={styles.resumo}>
        <p><strong>Operador atual:</strong> {aluno?.operador_nome || "Sem operador"}</p>
        <p><strong>Última interação:</strong> {dataHoraBR(aluno?.ultima_interacao_em)}</p>
        <p>
          <strong>Próximo retorno:</strong>{" "}
          {aluno?.data_retorno || "-"} {aluno?.hora_retorno ? `às ${String(aluno.hora_retorno).slice(0, 5)}` : ""}
        </p>
      </div>

      <div style={styles.grid}>
        <input
          style={styles.input}
          placeholder="Operador responsável"
          value={form.operador_nome}
          onChange={(e) => setForm({ ...form, operador_nome: e.target.value })}
        />

        <select
          style={styles.input}
          value={form.status_jornada}
          onChange={(e) => setForm({ ...form, status_jornada: e.target.value })}
        >
          <option value="EM_COBRANCA">Em cobrança</option>
          <option value="RETORNO_AGENDADO">Retorno agendado</option>
          <option value="EM_NEGOCIACAO">Em negociação</option>
          <option value="AGUARDANDO_LINK">Aguardando link</option>
          <option value="AGUARDANDO_TERMO">Aguardando termo</option>
          <option value="PAGAMENTO_IDENTIFICADO">Pagamento identificado</option>
          <option value="REVISAR_UNIFICACAO">Revisar unificação</option>
          <option value="NAO_CONTATAR">Não contatar</option>
          <option value="QUITADO">Quitado</option>
        </select>

        <select
          style={styles.input}
          value={form.prioridade_operacional}
          onChange={(e) => setForm({ ...form, prioridade_operacional: e.target.value })}
        >
          <option value="NORMAL">Prioridade normal</option>
          <option value="ALTA">Prioridade alta</option>
          <option value="CRITICO">Crítico</option>
        </select>

      </div>

      <textarea
        style={styles.textarea}
        placeholder="Observação operacional / próxima ação"
        value={form.observacao_operacional}
        onChange={(e) => setForm({ ...form, observacao_operacional: e.target.value })}
      />

      <button style={styles.botaoAzul} onClick={salvarAgenda} disabled={salvando}>
        {salvando ? "Salvando..." : "Salvar agenda / próxima ação"}
      </button>
    </div>
  );
}

const styles = {
  card: {
    background: "var(--rv-superficie)",
    borderRadius: "14px",
    padding: "18px",
    marginBottom: "16px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    borderLeft: "6px solid #0d6efd",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "flex-start",
    marginBottom: "14px",
  },
  titulo: {
    margin: 0,
    color: "var(--rv-tinta)",
  },
  texto: {
    margin: "6px 0 0 0",
    color: "var(--rv-texto)",
  },
  statusBox: {
    background: "#111827",
    color: "#fff",
    borderRadius: "12px",
    padding: "12px 16px",
    minWidth: "160px",
  },
  resumo: {
    background: "var(--rv-fundo-cartao)",
    border: "1px solid var(--rv-borda)",
    borderRadius: "10px",
    padding: "12px",
    marginBottom: "14px",
    color: "var(--rv-texto-forte)",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
    gap: "10px",
  },
  input: {
    padding: "11px",
    borderRadius: "8px",
    border: "1px solid var(--rv-borda-forte)",
    fontSize: "14px",
  },
  textarea: {
    width: "100%",
    minHeight: "75px",
    marginTop: "10px",
    padding: "11px",
    borderRadius: "8px",
    border: "1px solid var(--rv-borda-forte)",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
  },
  botaoAzul: {
    background: "#0d6efd",
    color: "#fff",
    border: "none",
    padding: "11px 14px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
    marginTop: "10px",
  },
};
