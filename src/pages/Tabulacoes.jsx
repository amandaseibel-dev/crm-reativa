import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import {
  GRUPOS_TABULACAO,
  MODOS_RETORNO,
  PROXIMAS_ACOES,
  invalidarCacheTabulacoes,
} from "../utils/tabulacoes";

// Gestão do catálogo de tabulações (/tabulacoes) -- SOMENTE Amanda (decisão
// dela, 2026-08-17; mais restrito que a Calibragem de propósito). A rota é
// gateada no App.jsx e as RPCs conferem
// public.usuario_pode_editar_tabulacoes() de novo no banco.
//
// PRINCÍPIO QUE A TELA PRECISA DEIXAR CLARO PRA QUEM EDITA:
// mexer aqui NÃO reescreve agendamento nenhum. Uma tabulação nova, um prazo
// alterado ou uma tabulação desativada só valem a partir da PRÓXIMA vez que o
// aluno for tabulado. Quem está com retorno marcado pro dia 25 continua no
// dia 25. Por isso "excluir" é DESATIVAR (reversível) e a confirmação mostra
// quantos alunos seguem intactos naquela tabulação.

const VAZIO = {
  codigo: "",
  rotulo: "",
  grupo: "CONTATO",
  retorno_modo: "NENHUM",
  retorno_dias_uteis: "",
  proxima_acao: "CONTATAR",
  bloco_ficha: "",
  exige_processo: false,
  bloqueia_acionamento: false,
};

const BLOCOS = [
  { chave: "", rotulo: "Nenhum" },
  { chave: "link", rotulo: "Link de pagamento" },
  { chave: "termo", rotulo: "Termo / acordo" },
  { chave: "financeiro", rotulo: "Enviar ao financeiro" },
  { chave: "confirmar", rotulo: "Confirmar pagamento" },
];

// Código estável a partir do rótulo: "Aguardando retorno do RH" ->
// "AGUARDANDO_RETORNO_DO_RH". Só é sugerido na criação; depois o código nunca
// muda, porque o histórico dos alunos aponta pra ele.
function sugerirCodigo(rotulo) {
  return String(rotulo || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

export default function Tabulacoes() {
  const [lista, setLista] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [form, setForm] = useState(VAZIO);
  const [editando, setEditando] = useState(null); // código em edição, ou null
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState(null);
  const [confirmar, setConfirmar] = useState(null); // { tabulacao, impacto }
  const [mostrarInativas, setMostrarInativas] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    const { data, error } = await supabase
      .from("tabulacoes")
      .select("*")
      .order("ordem", { ascending: true })
      .order("rotulo", { ascending: true });
    if (error) {
      setAviso({ tipo: "erro", texto: `Não foi possível carregar o catálogo: ${error.message}` });
    } else {
      setLista(data || []);
    }
    setCarregando(false);
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const porGrupo = useMemo(() => {
    const visiveis = lista.filter((t) => mostrarInativas || t.ativa);
    return GRUPOS_TABULACAO.map((g) => ({
      ...g,
      itens: visiveis.filter((t) => t.grupo === g.chave),
    })).filter((g) => g.itens.length > 0);
  }, [lista, mostrarInativas]);

  function iniciarEdicao(t) {
    setEditando(t.codigo);
    setForm({
      codigo: t.codigo,
      rotulo: t.rotulo,
      grupo: t.grupo,
      retorno_modo: t.retorno_modo,
      retorno_dias_uteis: t.retorno_dias_uteis ?? "",
      proxima_acao: t.proxima_acao,
      bloco_ficha: t.bloco_ficha || "",
      exige_processo: t.exige_processo,
      bloqueia_acionamento: t.bloqueia_acionamento,
    });
    setAviso(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelarEdicao() {
    setEditando(null);
    setForm(VAZIO);
    setAviso(null);
  }

  async function salvar(e) {
    e.preventDefault();
    if (salvando) return;

    const codigo = editando || form.codigo || sugerirCodigo(form.rotulo);
    if (!form.rotulo.trim()) {
      setAviso({ tipo: "erro", texto: "Escreva o nome que o operador vai ver na lista." });
      return;
    }
    if (!/^[A-Z][A-Z0-9_]{2,59}$/.test(codigo)) {
      setAviso({
        tipo: "erro",
        texto: "Código inválido. Use letras maiúsculas, números e _ (mínimo 3 caracteres), começando por letra.",
      });
      return;
    }
    if (form.retorno_modo === "DIAS_UTEIS") {
      const d = Number(form.retorno_dias_uteis);
      if (!Number.isInteger(d) || d < 0 || d > 365) {
        setAviso({ tipo: "erro", texto: "Informe o prazo em dias úteis (0 a 365)." });
        return;
      }
    }

    setSalvando(true);
    setAviso(null);
    const { error } = await supabase.rpc("tabulacao_salvar", {
      p_codigo: codigo,
      p_rotulo: form.rotulo.trim(),
      p_grupo: form.grupo,
      p_retorno_modo: form.retorno_modo,
      p_retorno_dias_uteis:
        form.retorno_modo === "DIAS_UTEIS" ? Number(form.retorno_dias_uteis) : null,
      p_proxima_acao: form.proxima_acao,
      p_bloco_ficha: form.bloco_ficha || null,
      p_exige_processo: form.exige_processo,
      p_bloqueia_acionamento: form.bloqueia_acionamento,
      p_ordem: null,
    });
    setSalvando(false);

    if (error) {
      setAviso({ tipo: "erro", texto: traduzirErro(error) });
      return;
    }
    invalidarCacheTabulacoes();
    setAviso({
      tipo: "ok",
      texto: editando
        ? `"${form.rotulo.trim()}" atualizada. A regra nova vale a partir da próxima tabulação — nenhum retorno já agendado foi mexido.`
        : `"${form.rotulo.trim()}" criada e já disponível pra equipe tabular.`,
    });
    cancelarEdicao();
    await carregar();
  }

  // Antes de desativar, busca o impacto pra mostrar exatamente o que continua
  // de pé (é a garantia visível de "respeita o que já está agendado").
  async function pedirDesativacao(t) {
    const { data, error } = await supabase.rpc("tabulacao_impacto", { p_codigo: t.codigo });
    if (error) {
      setAviso({ tipo: "erro", texto: traduzirErro(error) });
      return;
    }
    setConfirmar({ tabulacao: t, impacto: data || {} });
  }

  async function desativar() {
    if (!confirmar || salvando) return;
    setSalvando(true);
    const { error } = await supabase.rpc("tabulacao_desativar", {
      p_codigo: confirmar.tabulacao.codigo,
    });
    setSalvando(false);
    setConfirmar(null);
    if (error) {
      setAviso({ tipo: "erro", texto: traduzirErro(error) });
      return;
    }
    invalidarCacheTabulacoes();
    setAviso({
      tipo: "ok",
      texto: `"${confirmar.tabulacao.rotulo}" saiu da lista de tabular. Quem já estava nela seguiu intacto, com o retorno agendado que tinha.`,
    });
    await carregar();
  }

  async function reativar(t) {
    setSalvando(true);
    const { error } = await supabase.rpc("tabulacao_reativar", { p_codigo: t.codigo });
    setSalvando(false);
    if (error) {
      setAviso({ tipo: "erro", texto: traduzirErro(error) });
      return;
    }
    invalidarCacheTabulacoes();
    setAviso({ tipo: "ok", texto: `"${t.rotulo}" voltou pra lista de tabular.` });
    await carregar();
  }

  return (
    <div style={S.wrap}>
      <h1 style={S.titulo}>🏷️ Tabulações</h1>
      <p style={S.sub}>
        O que a equipe pode escolher ao finalizar um atendimento, e o que o sistema faz com
        cada escolha.
      </p>

      <div style={S.nota}>
        <strong>Mexer aqui não desfaz agendamento.</strong> Criar uma tabulação, mudar o prazo
        de retorno de uma existente ou tirar uma da lista só vale{" "}
        <strong>a partir da próxima vez que o aluno for tabulado</strong>. Quem já está com
        retorno marcado pro dia 25 continua no dia 25.
      </div>

      {aviso && (
        <div style={aviso.tipo === "erro" ? S.avisoErro : S.avisoOk}>{aviso.texto}</div>
      )}

      {/* ---------------- formulário ---------------- */}
      <form onSubmit={salvar} style={S.cardForm}>
        <h2 style={S.h2}>
          {editando ? `Editando: ${editando}` : "Incluir tabulação"}
        </h2>

        <div style={S.linha}>
          <div style={S.campo}>
            <label style={S.label}>Nome que o operador vê</label>
            <input
              style={S.input}
              value={form.rotulo}
              maxLength={80}
              placeholder="Ex.: Aguardando resposta do responsável"
              onChange={(e) => setForm((f) => ({ ...f, rotulo: e.target.value }))}
            />
          </div>
          <div style={S.campo}>
            <label style={S.label}>
              Código interno {editando && <span style={S.hintInline}>(não muda)</span>}
            </label>
            <input
              style={{ ...S.input, ...(editando ? S.inputTravado : null) }}
              value={editando || form.codigo || sugerirCodigo(form.rotulo)}
              disabled={Boolean(editando)}
              onChange={(e) => setForm((f) => ({ ...f, codigo: e.target.value.toUpperCase() }))}
            />
            <span style={S.hint}>
              É por ele que o histórico e as filas casam. Depois de criado, nunca muda.
            </span>
          </div>
        </div>

        <div style={S.linha}>
          <div style={S.campo}>
            <label style={S.label}>Grupo</label>
            <select
              style={S.input}
              value={form.grupo}
              onChange={(e) => setForm((f) => ({ ...f, grupo: e.target.value }))}
            >
              {GRUPOS_TABULACAO.map((g) => (
                <option key={g.chave} value={g.chave}>{g.rotulo}</option>
              ))}
            </select>
          </div>
          <div style={S.campo}>
            <label style={S.label}>Próxima ação sugerida</label>
            <select
              style={S.input}
              value={form.proxima_acao}
              onChange={(e) => setForm((f) => ({ ...f, proxima_acao: e.target.value }))}
            >
              {PROXIMAS_ACOES.map((a) => (
                <option key={a} value={a}>
                  {a.charAt(0) + a.slice(1).toLowerCase().replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={S.linha}>
          <div style={S.campo}>
            <label style={S.label}>Retorno automático</label>
            <select
              style={S.input}
              value={form.retorno_modo}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  retorno_modo: e.target.value,
                  retorno_dias_uteis: e.target.value === "DIAS_UTEIS" ? f.retorno_dias_uteis : "",
                }))
              }
            >
              {MODOS_RETORNO.map((m) => (
                <option key={m.chave} value={m.chave}>{m.rotulo}</option>
              ))}
            </select>
            <span style={S.hint}>
              Vale só quando o operador tabula <em>sem</em> digitar uma data. Data digitada
              sempre ganha.
            </span>
          </div>
          <div style={S.campo}>
            <label style={S.label}>Prazo (dias úteis)</label>
            <input
              style={{
                ...S.input,
                ...(form.retorno_modo !== "DIAS_UTEIS" ? S.inputTravado : null),
              }}
              type="number"
              min={0}
              max={365}
              disabled={form.retorno_modo !== "DIAS_UTEIS"}
              value={form.retorno_dias_uteis}
              onChange={(e) => setForm((f) => ({ ...f, retorno_dias_uteis: e.target.value }))}
            />
            <span style={S.hint}>Fim de semana não conta.</span>
          </div>
        </div>

        <div style={S.linha}>
          <div style={S.campo}>
            <label style={S.label}>Abrir bloco na ficha</label>
            <select
              style={S.input}
              value={form.bloco_ficha}
              onChange={(e) => setForm((f) => ({ ...f, bloco_ficha: e.target.value }))}
            >
              {BLOCOS.map((b) => (
                <option key={b.chave} value={b.chave}>{b.rotulo}</option>
              ))}
            </select>
            <span style={S.hint}>
              Ao escolher a tabulação, esse formulário abre sozinho na ficha.
            </span>
          </div>
          <div style={S.campo}>
            <label style={S.label}>Regras extras</label>
            <label style={S.check}>
              <input
                type="checkbox"
                checked={form.exige_processo}
                onChange={(e) => setForm((f) => ({ ...f, exige_processo: e.target.checked }))}
              />
              Pedir número do processo
            </label>
            <label style={S.check}>
              <input
                type="checkbox"
                checked={form.bloqueia_acionamento}
                onChange={(e) =>
                  setForm((f) => ({ ...f, bloqueia_acionamento: e.target.checked }))
                }
              />
              Encerra o caso (só gestão pode escolher)
            </label>
          </div>
        </div>

        <div style={S.acoesForm}>
          <button type="submit" style={S.btnPrim} disabled={salvando}>
            {salvando ? "Salvando..." : editando ? "Salvar alterações" : "Incluir tabulação"}
          </button>
          {editando && (
            <button type="button" style={S.btnSec} onClick={cancelarEdicao}>
              Cancelar
            </button>
          )}
        </div>
      </form>

      {/* ---------------- lista ---------------- */}
      <div style={S.barraLista}>
        <h2 style={S.h2}>Catálogo</h2>
        <label style={S.check}>
          <input
            type="checkbox"
            checked={mostrarInativas}
            onChange={(e) => setMostrarInativas(e.target.checked)}
          />
          Mostrar as que saíram da lista
        </label>
      </div>

      {carregando && <p style={S.sub}>Carregando...</p>}

      {porGrupo.map((g) => (
        <div key={g.chave} style={{ marginBottom: 22 }}>
          <h3 style={S.h3}>{g.rotulo}</h3>
          <div style={S.tabelaWrap}>
            <table style={S.tabela}>
              <thead>
                <tr>
                  <th style={S.th}>Tabulação</th>
                  <th style={S.th}>Código</th>
                  <th style={S.th}>Retorno automático</th>
                  <th style={S.th}>Próxima ação</th>
                  <th style={S.thDir}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {g.itens.map((t) => (
                  <tr key={t.codigo} style={t.ativa ? null : S.trInativa}>
                    <td style={S.td}>
                      <strong>{t.rotulo}</strong>
                      {t.sistema && <span style={S.tagSistema}>sistema</span>}
                      {!t.ativa && <span style={S.tagInativa}>fora da lista</span>}
                      {t.bloqueia_acionamento && <span style={S.tagTrava}>encerra o caso</span>}
                    </td>
                    <td style={S.tdCodigo}>{t.codigo}</td>
                    <td style={S.td}>{descreverRetorno(t)}</td>
                    <td style={S.td}>
                      {t.proxima_acao.charAt(0) +
                        t.proxima_acao.slice(1).toLowerCase().replace(/_/g, " ")}
                    </td>
                    <td style={S.tdDir}>
                      <button style={S.btnMini} onClick={() => iniciarEdicao(t)}>
                        Editar
                      </button>
                      {t.ativa ? (
                        <button style={S.btnMiniPerigo} onClick={() => pedirDesativacao(t)}>
                          Tirar da lista
                        </button>
                      ) : (
                        <button style={S.btnMini} onClick={() => reativar(t)}>
                          Devolver à lista
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* ---------------- confirmação de desativação ---------------- */}
      {confirmar && (
        <div style={S.overlay} onClick={() => setConfirmar(null)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={S.h2}>Tirar "{confirmar.tabulacao.rotulo}" da lista?</h2>

            {confirmar.tabulacao.sistema && (
              <div style={S.avisoErro}>
                <strong>Atenção: esta é uma tabulação de sistema.</strong> O código{" "}
                <code>{confirmar.tabulacao.codigo}</code> é usado por fila/automação do
                backend ({dependenciaDe(confirmar.tabulacao)}). Tirando da lista, a equipe
                deixa de conseguir alimentar essa fila pela tabulação.
              </div>
            )}

            <ul style={S.ul}>
              <li>
                <strong>{confirmar.impacto.alunos ?? 0}</strong> aluno(s) estão nessa tabulação
                agora — e <strong>continuam nela</strong>, sem alteração.
              </li>
              <li>
                <strong>{confirmar.impacto.alunos_com_retorno_agendado ?? 0}</strong> desses têm
                retorno agendado — <strong>as datas ficam como estão</strong>. Só mudam quando
                o operador tabular de novo.
              </li>
              <li>
                <strong>{confirmar.impacto.movimentacoes ?? 0}</strong> registro(s) no histórico
                continuam legíveis com esse nome.
              </li>
              <li>A opção some do seletor de tabular. Nada é apagado — dá pra devolver depois.</li>
            </ul>

            <div style={S.acoesForm}>
              <button style={S.btnPerigo} onClick={desativar} disabled={salvando}>
                {salvando ? "Tirando..." : "Tirar da lista"}
              </button>
              <button style={S.btnSec} onClick={() => setConfirmar(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function descreverRetorno(t) {
  if (t.retorno_modo === "DIAS_UTEIS") {
    const d = Number(t.retorno_dias_uteis);
    return d === 0 ? "Hoje mesmo" : `${d} dia${d > 1 ? "s" : ""} útil(eis)`;
  }
  if (t.retorno_modo === "MANUAL") return "Operador escolhe a data";
  return "Não agenda";
}

// Qual parte do backend casa por este código -- pra confirmação não ser um
// aviso genérico.
function dependenciaDe(t) {
  if (t.grupo === "FINANCEIRO") return "fila de confirmação de pagamento / baixas";
  if (t.grupo === "TERMO") return "fila de termos (ADM)";
  if (t.grupo === "LINK") return "fluxo de link de pagamento";
  if (t.grupo === "ENCERRAMENTO") return "trava de ficha encerrada";
  return "automações do CRM";
}

function traduzirErro(error) {
  const msg = String(error?.message || error?.details || "erro desconhecido");
  if (error?.code === "42501" || /permiss/i.test(msg)) {
    return "Sem permissão: só a Amanda pode alterar o catálogo de tabulações.";
  }
  if (/ux_tabulacoes_rotulo_ativa/.test(msg)) {
    return "Já existe uma tabulação ativa com esse nome. Escolha outro nome.";
  }
  if (/tabulacoes_codigo_formato/.test(msg)) {
    return "Código inválido. Use letras maiúsculas, números e _ , começando por letra.";
  }
  if (/tabulacoes_retorno_coerente/.test(msg)) {
    return "Prazo em dias úteis só vale no modo \"Agenda em X dias úteis\".";
  }
  return msg;
}

const S = {
  wrap: { padding: "28px 30px 60px", fontFamily: "'Inter', system-ui, sans-serif", color: "#0f172a", background: "#f4f6fa", minHeight: "100%" },
  titulo: { margin: 0, fontFamily: "'Sora', Inter, sans-serif", fontSize: 26, fontWeight: 800, color: "#0d1321", letterSpacing: "-0.03em" },
  sub: { margin: "6px 0 18px", color: "#64748b", fontSize: 13.5 },
  h2: { fontFamily: "'Sora', Inter, sans-serif", fontSize: 17, fontWeight: 800, margin: "0 0 14px", color: "#0d1321" },
  h3: { fontFamily: "'Sora', Inter, sans-serif", fontSize: 14, fontWeight: 800, margin: "0 0 8px", color: "#334155", textTransform: "uppercase", letterSpacing: "0.04em" },
  nota: { background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e3a8a", borderRadius: 12, padding: "12px 16px", fontSize: 13, lineHeight: 1.55, marginBottom: 18 },
  avisoOk: { background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: 12, padding: "11px 15px", fontSize: 13, marginBottom: 16, lineHeight: 1.5 },
  avisoErro: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 12, padding: "11px 15px", fontSize: 13, marginBottom: 16, lineHeight: 1.5 },
  cardForm: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 16, padding: 20, marginBottom: 26, boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  linha: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginBottom: 14 },
  campo: { display: "flex", flexDirection: "column", gap: 5 },
  label: { fontSize: 12, fontWeight: 700, color: "#334155" },
  hint: { fontSize: 11.5, color: "#94a3b8", lineHeight: 1.4 },
  hintInline: { fontSize: 11, color: "#94a3b8", fontWeight: 500 },
  input: { border: "1px solid #d7dde7", borderRadius: 10, padding: "9px 11px", fontSize: 13.5, fontFamily: "inherit", color: "#0f172a", background: "#fff", width: "100%", boxSizing: "border-box" },
  inputTravado: { background: "#f1f5f9", color: "#64748b" },
  check: { display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "#334155", cursor: "pointer" },
  acoesForm: { display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" },
  btnPrim: { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 10, padding: "10px 20px", fontWeight: 800, fontSize: 13.5, cursor: "pointer" },
  btnSec: { background: "#fff", color: "#334155", border: "1px solid #d7dde7", borderRadius: 10, padding: "10px 20px", fontWeight: 700, fontSize: 13.5, cursor: "pointer" },
  btnPerigo: { background: "#dc2626", color: "#fff", border: "none", borderRadius: 10, padding: "10px 20px", fontWeight: 800, fontSize: 13.5, cursor: "pointer" },
  btnMini: { background: "#fff", color: "#334155", border: "1px solid #d7dde7", borderRadius: 8, padding: "5px 11px", fontWeight: 700, fontSize: 12, cursor: "pointer", marginLeft: 6 },
  btnMiniPerigo: { background: "#fff", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 8, padding: "5px 11px", fontWeight: 700, fontSize: 12, cursor: "pointer", marginLeft: 6 },
  barraLista: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 14 },
  tabelaWrap: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 14, overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "10px 14px", fontSize: 11.5, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "1px solid #eef2f7", whiteSpace: "nowrap" },
  thDir: { textAlign: "right", padding: "10px 14px", fontSize: 11.5, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "1px solid #eef2f7", whiteSpace: "nowrap" },
  td: { padding: "10px 14px", borderBottom: "1px solid #f4f6fa", color: "#0f172a", verticalAlign: "middle" },
  tdCodigo: { padding: "10px 14px", borderBottom: "1px solid #f4f6fa", color: "#64748b", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 },
  tdDir: { padding: "10px 14px", borderBottom: "1px solid #f4f6fa", textAlign: "right", whiteSpace: "nowrap" },
  trInativa: { opacity: 0.6 },
  tagSistema: { marginLeft: 8, background: "#eef2ff", color: "#3730a3", fontSize: 10.5, fontWeight: 800, padding: "2px 7px", borderRadius: 999 },
  tagInativa: { marginLeft: 8, background: "#f1f5f9", color: "#64748b", fontSize: 10.5, fontWeight: 800, padding: "2px 7px", borderRadius: 999 },
  tagTrava: { marginLeft: 8, background: "#fef2f2", color: "#b91c1c", fontSize: 10.5, fontWeight: 800, padding: "2px 7px", borderRadius: 999 },
  overlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 1000 },
  modal: { background: "#fff", borderRadius: 16, padding: 24, maxWidth: 560, width: "100%", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 50px rgba(15,23,42,0.3)" },
  ul: { margin: "0 0 18px", paddingLeft: 20, fontSize: 13.5, lineHeight: 1.65, color: "#334155" },
};
