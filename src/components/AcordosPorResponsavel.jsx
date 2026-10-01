import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Vazio } from "../ui/estados";
import { cartaoEscuro } from "../ui/cards";
import {
  CLASSES_CASO,
  STATUS_ACORDO,
  donoDoCaso,
  moeda,
  resumoAcordos,
  rotuloClasseCaso,
  totalPaginas,
  validarMovimentoAcordos,
} from "../utils/carteiraGeral";

// ============================================================================
// ACORDOS POR RESPONSÁVEL
//
// A Carteira Geral responde "de quem é o CASO". Esta seção responde "de quem é
// o ACORDO" — que é outra coisa, e a diferença é grande: medido em produção em
// 27/09/2026, a gestora tinha 11 casos e 753 acordos sob sua responsabilidade,
// 726 deles em casos de outras pessoas.
//
// Mover o acordo aqui NÃO move o caso nem a ficha. O gatilho que faria isso
// (trg_aluno_segue_dono_do_acordo) é suspenso dentro da transação, e a própria
// função confere depois que caso e ficha continuam como estavam.
// ============================================================================

const POR_PAGINA = 100;

export default function AcordosPorResponsavel({ meuEmail }) {
  // Quem TEM acordo — inclui operador desligado (a Olga responde por 127) e a
  // gestão, que não tem perfil "operador". Usar a lista de operadores ativos
  // deixaria essas carteiras inalcançáveis, que foi o defeito do PR #531.
  const [responsaveis, setResponsaveis] = useState([]);
  // Destinos validos, vindos da MESMA regra que a RPC aplica
  // (internal.acordo_destino_valido): operador ATIVO ou a Carteira Geral.
  // Nao sai de `responsaveis`: aquela lista e de quem TEM acordo, e (a) a
  // Carteira Geral cairia no filtro de ativo, (b) operador ativo sem acordo
  // nenhum nao poderia receber.
  const [destinos, setDestinos] = useState([]);
  const [painel, setPainel] = useState(null);
  const [lista, setLista] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const [filtros, setFiltros] = useState({
    responsavel: "", status: "ATIVO", classe_caso: "TODOS", busca: "",
  });
  const [pagina, setPagina] = useState(0);
  // acordo_id -> linha inteira, para o total sobreviver à troca de página
  const [selecionados, setSelecionados] = useState(() => new Map());

  const [destinoEmail, setDestinoEmail] = useState("");
  const [motivo, setMotivo] = useState("");
  const [previa, setPrevia] = useState(null);

  const filtrosRpc = useMemo(
    () => ({
      responsavel: filtros.responsavel || meuEmail || null,
      status: filtros.status || "ATIVO",
      classe_caso: filtros.classe_caso || "TODOS",
      busca: filtros.busca || null,
    }),
    [filtros, meuEmail]
  );

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    const [{ data: p, error: e1 }, { data: l, error: e2 }] = await Promise.all([
      supabase.rpc("carteira_geral_acordos_painel", { p_filtros: filtrosRpc }),
      supabase.rpc("carteira_geral_acordos_listar", {
        p_filtros: filtrosRpc, p_limite: POR_PAGINA, p_offset: pagina * POR_PAGINA,
      }),
    ]);
    setCarregando(false);
    if (e1 || e2) {
      setErro((e1 || e2).message || "Não foi possível carregar os acordos.");
      return;
    }
    setPainel(p || null);
    setLista(Array.isArray(l) ? l : []);
    setPrevia(null);
  }, [filtrosRpc, pagina]);

  useEffect(() => {
    let vivo = true;
    supabase.rpc("carteira_geral_acordos_responsaveis").then(({ data }) => {
      if (vivo && Array.isArray(data)) setResponsaveis(data);
    });
    supabase.rpc("carteira_geral_acordos_destinos").then(({ data }) => {
      if (vivo && Array.isArray(data)) setDestinos(data);
    });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    // mesmo padrão da Carteira Geral: a carga inicial e as recargas por filtro
    // nascem de um efeito; `carregar` é useCallback e só muda com os filtros.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    carregar();
  }, [carregar]);

  function mudarFiltro(patch) {
    setFiltros((a) => ({ ...a, ...patch }));
    setPagina(0);
    setSelecionados(new Map());
    setPrevia(null);
  }

  function alternar(id) {
    setSelecionados((atual) => {
      const novo = new Map(atual);
      if (novo.has(id)) novo.delete(id);
      else {
        const linha = lista.find((x) => x.acordo_id === id);
        if (linha) novo.set(id, linha);
      }
      return novo;
    });
    setPrevia(null);
  }

  function alternarTodos() {
    setSelecionados((atual) => {
      const novo = new Map(atual);
      const todos = lista.length > 0 && lista.every((x) => novo.has(x.acordo_id));
      for (const x of lista) {
        if (todos) novo.delete(x.acordo_id);
        else novo.set(x.acordo_id, x);
      }
      return novo;
    });
    setPrevia(null);
  }

  const selecao = [...selecionados.keys()];
  const resumo = resumoAcordos([...selecionados.values()]);
  const paginas = totalPaginas(contagemDoFiltro(painel, filtrosRpc), POR_PAGINA);

  async function gerarPrevia() {
    const check = validarMovimentoAcordos({ destinoEmail, motivo, selecionados: selecao });
    if (!check.ok) return setAviso(check.erro);
    setAviso("");
    setOcupado(true);
    const { data, error } = await supabase.rpc("carteira_geral_acordos_previa", {
      p_acordo_ids: selecao, p_destino_email: destinoEmail, p_filtros: filtrosRpc,
    });
    setOcupado(false);
    if (error) return setAviso("Não foi possível gerar a prévia: " + (error.message || ""));
    setPrevia(data || null);
  }

  async function confirmar() {
    if (!previa?.previa_id) return setAviso("Gere a prévia antes de confirmar.");
    const ok = window.confirm(
      `Mover ${previa.total_acordos} acordo(s) — ${moeda(previa.total_valor)} — para ` +
        `${previa.destino_nome}?\n\n` +
        (previa.total_em_caso_de_outro
          ? `ATENÇÃO: ${previa.total_em_caso_de_outro} acordo(s) estão em casos de OUTRAS pessoas.\n` +
            "O caso e a ficha desses alunos NÃO mudam de dono — só o acordo.\n\n"
          : "") +
        "Não muda parcela, pagamento, honorário nem quem negociou."
    );
    if (!ok) return;

    setOcupado(true);
    const { data, error } = await supabase.rpc("carteira_geral_acordos_mover", {
      p_previa_id: previa.previa_id, p_motivo: motivo,
    });
    setOcupado(false);
    if (error) return setAviso("Não foi possível mover: " + (error.message || ""));

    const rec = Number(data?.total_recusados || 0);
    setAviso(
      `${data?.acordos_movidos || 0} acordo(s) movidos para ${data?.destino_nome}. ` +
        "Nenhum caso e nenhuma ficha foram movidos. " +
        `Lote ${data?.lote_id}.` +
        (rec ? ` ${rec} recusado(s) — algo mudou depois da prévia.` : "")
    );
    setMotivo("");
    setSelecionados(new Map());
    carregar();
  }

  if (erro) return <section style={cartao}><p style={avisoTexto}>{erro}</p></section>;

  const porStatus = Object.fromEntries((painel?.por_status || []).map((x) => [x.status, x]));
  const porClasse = Object.fromEntries((painel?.por_dono_do_caso || []).map((x) => [x.classe, x]));

  return (
    <section style={cartao} data-testid="acordos-por-responsavel">
      <h2 style={secao}>Acordos por responsável</h2>
      <span style={nota}>
        Aqui o dono é o do <strong>acordo</strong>, não o do caso. Um acordo seu pode estar num caso
        de outra pessoa — isso é normal, e mover o acordo <strong>não</strong> move o caso nem a
        ficha do aluno.
      </span>

      {/* ---------------- contadores, separados dos de caso ---------------- */}
      <div style={grade}>
        <Bloco titulo="Acordos do responsável" valor={String(painel?.total_acordos ?? 0)} nota="todos os status" />
        <Bloco titulo="Valor" valor={moeda(painel?.total_valor)} />
        <Bloco titulo="Alunos" valor={String(painel?.alunos ?? 0)} />
        <Bloco
          titulo="Em caso de outra pessoa"
          valor={String(painel?.em_caso_de_outro ?? 0)}
          nota="o caso fica com quem está"
          alerta={Number(painel?.em_caso_de_outro || 0) > 0}
        />
        <Bloco titulo="ATIVO" valor={String(porStatus.ATIVO?.acordos ?? 0)} nota={moeda(porStatus.ATIVO?.valor)} />
        <Bloco titulo="QUITADO" valor={String(porStatus.QUITADO?.acordos ?? 0)} />
        <Bloco titulo="CANCELADO" valor={String(porStatus.CANCELADO?.acordos ?? 0)} />
      </div>

      <table style={tabela}>
        <thead>
          <tr>
            <th style={th}>Onde está o caso</th>
            <th style={thNum}>Acordos</th>
            <th style={thNum}>ATIVO</th>
            <th style={thNum}>Valor</th>
          </tr>
        </thead>
        <tbody>
          {CLASSES_CASO.filter((c) => c.valor !== "TODOS").map((c) => (
            <tr key={c.valor}>
              <td style={td}>{c.rotulo}</td>
              <td style={tdNum}>{porClasse[c.valor]?.acordos ?? 0}</td>
              <td style={tdNum}>{porClasse[c.valor]?.ativos ?? 0}</td>
              <td style={tdNum}>{moeda(porClasse[c.valor]?.valor)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ---------------- filtros próprios ---------------- */}
      <h3 style={secaoMenor}>Filtrar acordos</h3>
      <div style={linhaFiltros}>
        <label style={campo}>
          <span style={rotulo}>Responsável pelo acordo</span>
          <select
            value={filtros.responsavel}
            onChange={(e) => mudarFiltro({ responsavel: e.target.value })}
            style={input}
          >
            <option value="">Meus acordos</option>
            {responsaveis.map((o) => (
              <option key={o.email} value={o.email}>
                {rotuloResponsavelAcordo(o)}
              </option>
            ))}
          </select>
        </label>

        <label style={campo}>
          <span style={rotulo}>Status do acordo</span>
          <select value={filtros.status} onChange={(e) => mudarFiltro({ status: e.target.value })} style={input}>
            {STATUS_ACORDO.map((s) => (
              <option key={s.valor} value={s.valor}>{s.rotulo}</option>
            ))}
          </select>
        </label>

        <label style={campo}>
          <span style={rotulo}>Onde está o caso</span>
          <select
            value={filtros.classe_caso}
            onChange={(e) => mudarFiltro({ classe_caso: e.target.value })}
            style={input}
          >
            {CLASSES_CASO.map((c) => (
              <option key={c.valor} value={c.valor}>{c.rotulo}</option>
            ))}
          </select>
        </label>

        <label style={campo}>
          <span style={rotulo}>Buscar</span>
          <input
            value={filtros.busca}
            onChange={(e) => mudarFiltro({ busca: e.target.value })}
            style={input}
            placeholder="aluno ou número do acordo"
          />
        </label>
      </div>

      {/* ---------------- lista ---------------- */}
      <h3 style={secaoMenor}>
        Selecionar acordos{" "}
        <span style={nota} data-testid="contagem-acordos">
          ({selecao.length} acordo(s) selecionado(s) no total)
        </span>
      </h3>

      {resumo.acordos > 0 && (
        <p style={nota} data-testid="resumo-acordos">
          <strong>{resumo.acordos}</strong> acordo(s) · <strong>{moeda(resumo.valor)}</strong> ·{" "}
          <strong>{resumo.alunos}</strong> aluno(s) ·{" "}
          <strong>{resumo.emCasoDeOutro}</strong> em caso de outra pessoa (o caso fica com quem está)
          {resumo.naoAtivos > 0 && <> · <strong>{resumo.naoAtivos}</strong> não estão ATIVO</>}.
        </p>
      )}

      {carregando ? (
        <p style={nota}>Carregando…</p>
      ) : lista.length === 0 ? (
        <Vazio texto="Nenhum acordo com este filtro." tema="escuro" />
      ) : (
        <table style={tabela}>
          <thead>
            <tr>
              <th style={th}>
                <input
                  type="checkbox"
                  aria-label="Selecionar todos os acordos"
                  checked={lista.length > 0 && lista.every((x) => selecionados.has(x.acordo_id))}
                  onChange={alternarTodos}
                />
              </th>
              <th style={th}>Aluno</th>
              <th style={th}>Acordo</th>
              <th style={th}>Status</th>
              <th style={thNum}>Valor</th>
              <th style={th}>Dono do caso</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((l) => (
              <tr key={l.acordo_id}>
                <td style={td}>
                  <input
                    type="checkbox"
                    aria-label={`Selecionar acordo ${l.numero_acordo}`}
                    checked={selecionados.has(l.acordo_id)}
                    onChange={() => alternar(l.acordo_id)}
                  />
                </td>
                <td style={td}>{l.nome}</td>
                <td style={td}>{l.numero_acordo}</td>
                <td style={td}>{l.status}</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{moeda(l.valor)}</td>
                <td style={{ ...td, color: l.caso_dono_classe === "EU" ? undefined : "var(--rv-ambar-texto)" }}>
                  {donoDoCaso(l)}
                  <span style={nota}> {rotuloClasseCaso(l.caso_dono_classe)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {paginas > 1 && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setPagina((n) => Math.max(n - 1, 0))}
                  disabled={pagina === 0 || ocupado} style={botao}>
            Anterior
          </button>
          <span style={nota} data-testid="paginacao-acordos">
            Página {pagina + 1} de {paginas}
          </span>
          <button type="button" onClick={() => setPagina((n) => Math.min(n + 1, paginas - 1))}
                  disabled={pagina >= paginas - 1 || ocupado} style={botao}>
            Próxima
          </button>
          <span style={nota}>A seleção é mantida ao trocar de página.</span>
        </div>
      )}

      {/* ---------------- mover ---------------- */}
      <h3 style={secaoMenor}>Mover os acordos selecionados</h3>
      <div style={linhaFiltros}>
        <label style={campo}>
          <span style={rotulo}>Novo responsável pelo acordo</span>
          <select value={destinoEmail} onChange={(e) => { setDestinoEmail(e.target.value); setPrevia(null); }} style={input}>
            <option value="">Selecione…</option>
            {destinos.map((o) => (
              <option key={o.email} value={o.email}>
                {o.tipo === "CARTEIRA_GERAL" ? `${o.nome} (gestão)` : o.nome || o.email}
              </option>
            ))}
          </select>
        </label>

        <label style={{ ...campo, maxWidth: 520 }}>
          <span style={rotulo}>Motivo (fica na auditoria)</span>
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            style={{ ...input, minHeight: 56 }}
            placeholder="Ex.: acordos da Olga passam para a Luana; os casos seguem com quem está."
          />
        </label>
      </div>

      <p style={nota}>
        Isto muda <strong>só o responsável pelo acordo</strong>. O caso e a ficha do aluno ficam com
        quem estão. Parcela, pagamento, honorário e quem negociou não são tocados.
      </p>

      <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
        <button type="button" onClick={gerarPrevia} disabled={ocupado || selecao.length === 0} style={botao}>
          {ocupado ? "Calculando…" : `Conferir movimentação de ${selecao.length} acordo(s)`}
        </button>
        <button
          type="button"
          onClick={confirmar}
          disabled={ocupado || !previa?.previa_id}
          style={{ ...botao, background: previa?.previa_id ? "var(--rv-verde-ok-fundo)" : "#374151" }}
        >
          Confirmar movimentação dos acordos
        </button>
      </div>

      {aviso && <p style={avisoTexto}>{aviso}</p>}

      {previa && (
        <div style={{ marginTop: 14 }}>
          <h3 style={secaoMenor}>Prévia — nada foi movido ainda</h3>
          <div style={grade}>
            <Bloco titulo="Acordos" valor={String(previa.total_acordos)} />
            <Bloco titulo="Valor" valor={moeda(previa.total_valor)} />
            <Bloco
              titulo="Em caso de outra pessoa"
              valor={String(previa.total_em_caso_de_outro)}
              nota="o caso NÃO se move"
              alerta={Number(previa.total_em_caso_de_outro || 0) > 0}
            />
            <Bloco titulo="Destino" valor={previa.destino_nome} />
          </div>

          {Array.isArray(previa.conflitos) && previa.conflitos.length > 0 && (
            <ul style={listaTexto} data-testid="conflitos-acordos">
              {previa.conflitos.map((c) => (
                <li key={`${c.tipo}-${c.acordo_id}`}>{c.detalhe}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// Quantos acordos o filtro atual alcança — para saber quantas páginas existem.
// O painel conta o universo do responsável; o recorte por status e por classe
// sai das quebras que ele já devolve.
// "Olga (127) — inativo": quem já não está na fila continua selecionável, e a
// marca diz por quê o nome não aparece nos destinos.
function rotuloResponsavelAcordo(o) {
  const base = `${o.nome || o.email} (${o.acordos})`;
  if (!o.existe_em_usuarios) return `${base} — fora de usuários`;
  return o.ativo ? base : `${base} — inativo`;
}

function contagemDoFiltro(painel, f) {
  if (!painel) return 0;
  if (f.classe_caso && f.classe_caso !== "TODOS") {
    const c = (painel.por_dono_do_caso || []).find((x) => x.classe === f.classe_caso);
    if (!c) return 0;
    return f.status === "ATIVO" ? Number(c.ativos || 0) : Number(c.acordos || 0);
  }
  if (f.status && f.status !== "TODOS") {
    const s = (painel.por_status || []).find((x) => x.status === f.status);
    return Number(s?.acordos || 0);
  }
  return Number(painel.total_acordos || 0);
}

function Bloco({ titulo, valor, nota: n, alerta }) {
  return (
    <div style={{ ...bloco, borderColor: alerta ? "var(--rv-ambar-borda)" : "#374151" }}>
      <span style={blocoTitulo}>{titulo}</span>
      <strong style={{ ...blocoValor, color: alerta ? "var(--rv-ambar-texto)" : undefined }}>{valor}</strong>
      {n && <span style={blocoNota}>{n}</span>}
    </div>
  );
}

const cartao = { ...cartaoEscuro, borderRadius: 12, padding: 16, marginBottom: 16 };
const secao = { fontSize: 16, fontWeight: 700, margin: "0 0 4px" };
const secaoMenor = { fontSize: 14, fontWeight: 700, margin: "16px 0 6px" };
const nota = { fontSize: 12, color: "var(--rv-texto-fraco)", display: "block", margin: "0 0 10px" };
const avisoTexto = { fontSize: 13, color: "var(--rv-ambar-texto)", marginTop: 10 };
const tabela = { width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 8 };
const th = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #374151", fontSize: 12, color: "var(--rv-texto-fraco)" };
const thNum = { ...th, textAlign: "right" };
const td = { padding: "6px 8px", borderBottom: "1px solid #1f2937" };
const tdNum = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const campo = { display: "flex", flexDirection: "column", gap: 4, minWidth: 220 };
const rotulo = { fontSize: 12, fontWeight: 600, color: "var(--rv-texto-fraco)" };
const input = { padding: "7px 9px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#f3f4f6", boxSizing: "border-box" };
const botao = { padding: "9px 16px", borderRadius: 8, border: "none", background: "var(--rv-azul)", color: "#fff", fontWeight: 700, cursor: "pointer" };
const linhaFiltros = { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 };
const grade = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 };
const bloco = { border: "1px solid #374151", borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 2 };
const blocoTitulo = { fontSize: 11, color: "var(--rv-texto-fraco)", fontWeight: 600 };
const blocoValor = { fontSize: 18, fontWeight: 800 };
const blocoNota = { fontSize: 11, color: "var(--rv-texto-fraco)" };
const listaTexto = { fontSize: 12, color: "var(--rv-texto-fraco)", margin: "6px 0 0", paddingLeft: 18 };
