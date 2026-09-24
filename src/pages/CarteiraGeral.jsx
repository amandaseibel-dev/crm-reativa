import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando, Erro, Vazio } from "../ui/estados";
import { cartaoEscuro } from "../ui/cards";
import {
  DESTINOS,
  O_QUE_MUDA,
  O_QUE_NAO_MUDA,
  acordosDeTerceiros,
  agruparConflitos,
  classeEmAlerta,
  consolidarPorAno,
  moeda,
  rotuloClasse,
  validarConfirmacao,
} from "../utils/carteiraGeral";

// ============================================================================
// CARTEIRA GERAL — destino operacional de gestão e remanejamento em lote.
//
// Acesso: os três logins individuais da gestão (Amanda gestora, Fernanda,
// Amanda ADM). Não existe senha compartilhada: a Carteira Geral é um DESTINO,
// não um usuário que se loga. O portão definitivo é do banco
// (public.calibragem_e_gestao, checado em toda RPC daqui).
//
// Fluxo obrigatório: filtrar → selecionar → PRÉVIA → conferir → confirmar.
// A tela nunca move nada direto: ela pede a prévia, mostra o que muda e só
// então chama carteira_geral_mover com o id daquela prévia.
// ============================================================================

const POR_PAGINA = 200;

export default function CarteiraGeral() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");

  const [painel, setPainel] = useState(null);
  const [lista, setLista] = useState([]);
  const [operadores, setOperadores] = useState([]);

  const [filtros, setFiltros] = useState({ responsavel: "", ano: "", tipo: "", busca: "" });
  const [selecionados, setSelecionados] = useState(() => new Set());

  const [destinoTipo, setDestinoTipo] = useState("CARTEIRA_GERAL");
  const [destinoEmail, setDestinoEmail] = useState("");
  const [moverAcordos, setMoverAcordos] = useState(true);
  // Acordo de terceiro só vai se o id estiver aqui. Decisão item a item.
  const [acordosEscolhidos, setAcordosEscolhidos] = useState(() => new Set());
  const [motivo, setMotivo] = useState("");

  const [previa, setPrevia] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const emVooRef = useRef(false);

  const filtrosRpc = useMemo(
    () => ({
      responsavel: filtros.responsavel || null,
      ano: filtros.ano ? Number(filtros.ano) : null,
      tipo: filtros.tipo || null,
      busca: filtros.busca || null,
    }),
    [filtros]
  );

  const carregar = useCallback(async () => {
    if (emVooRef.current) return;
    emVooRef.current = true;
    setCarregando(true);
    setErro("");

    const [{ data: p, error: e1 }, { data: l, error: e2 }] = await Promise.all([
      supabase.rpc("carteira_geral_painel", { p_filtros: filtrosRpc }),
      supabase.rpc("carteira_geral_listar", { p_filtros: filtrosRpc, p_limite: POR_PAGINA, p_offset: 0 }),
    ]);

    emVooRef.current = false;
    setCarregando(false);

    if (e1 || e2) {
      setErro((e1 || e2).message || "Não foi possível carregar a Carteira Geral.");
      return;
    }
    setPainel(p || null);
    setLista(Array.isArray(l) ? l : []);
    setSelecionados(new Set());
    setPrevia(null);
  }, [filtrosRpc]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    carregar();
  }, [carregar]);

  useEffect(() => {
    let vivo = true;
    supabase
      .from("usuarios")
      .select("email, nome, perfil, ativo, recebe_novos_casos")
      .eq("ativo", true)
      .eq("perfil", "operador")
      .order("nome")
      .then(({ data }) => {
        if (vivo && Array.isArray(data)) setOperadores(data);
      });
    return () => {
      vivo = false;
    };
  }, []);

  const porAno = useMemo(() => consolidarPorAno(painel?.por_ano), [painel]);
  const conflitos = useMemo(() => agruparConflitos(previa?.conflitos), [previa]);
  const terceiros = useMemo(() => acordosDeTerceiros(previa?.conflitos), [previa]);

  function alternarAcordo(acordoId) {
    setAcordosEscolhidos((atual) => {
      const novo = new Set(atual);
      if (novo.has(acordoId)) novo.delete(acordoId);
      else novo.add(acordoId);
      return novo;
    });
  }

  function alternar(alunoId) {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(alunoId)) novo.delete(alunoId);
      else novo.add(alunoId);
      return novo;
    });
    setPrevia(null);
  }

  function alternarTodos() {
    setSelecionados((atual) =>
      atual.size === lista.length ? new Set() : new Set(lista.map((l) => l.aluno_id))
    );
    setPrevia(null);
  }

  async function gerarPrevia() {
    const check = validarConfirmacao({
      destinoTipo,
      destinoEmail,
      motivo: motivo || "conferência",
      selecionados: [...selecionados],
    });
    if (!check.ok) {
      setAviso(check.erro);
      return;
    }

    setOcupado(true);
    setAviso("");
    const { data, error } = await supabase.rpc("carteira_geral_previa", {
      p_aluno_ids: [...selecionados],
      p_destino_tipo: destinoTipo,
      p_destino_email: destinoTipo === "OPERADOR" ? destinoEmail : null,
      p_mover_acordos: moverAcordos,
      p_filtros: filtrosRpc,
      p_acordo_ids: [...acordosEscolhidos],
    });
    setOcupado(false);

    if (error) {
      setAviso("Não foi possível gerar a prévia: " + (error.message || ""));
      return;
    }
    setPrevia(data || null);
  }

  async function confirmar() {
    const check = validarConfirmacao({
      destinoTipo,
      destinoEmail,
      motivo,
      selecionados: [...selecionados],
    });
    if (!check.ok) {
      setAviso(check.erro);
      return;
    }
    if (!previa?.previa_id) {
      setAviso("Gere a prévia antes de confirmar.");
      return;
    }

    const ok = window.confirm(
      `Mover ${previa.total_alunos} aluno(s) — ${moeda(previa.total_valor)} — para ${previa.destino_nome}?\n\n` +
        `Acordos que vão junto: ${previa.total_acordos}` +
        (previa.acordos_de_terceiros
          ? ` (${previa.acordos_de_terceiros_selecionados} de ${previa.acordos_de_terceiros} de terceiros, selecionados por você)`
          : "") + ".\n" +
        `Retornos agendados preservados: ${previa.retornos_preservados}.\n\n` +
        "Isso muda de quem é o caso. Não muda pagamento, baixa, valor nem quem negociou."
    );
    if (!ok) return;

    setOcupado(true);
    const { data, error } = await supabase.rpc("carteira_geral_mover", {
      p_previa_id: previa.previa_id,
      p_motivo: motivo,
    });
    setOcupado(false);

    if (error) {
      setAviso("Não foi possível mover: " + (error.message || ""));
      return;
    }

    const recusados = Number(data?.total_recusados || 0);
    setAviso(
      `${data?.alunos_movidos || 0} aluno(s) e ${data?.acordos_movidos || 0} acordo(s) movidos para ` +
        `${data?.destino_nome}. ${data?.retornos_preservados || 0} retorno(s) preservado(s). ` +
        `Lote ${data?.lote_id}.` +
        (recusados ? ` ${recusados} item(ns) recusado(s) porque mudaram depois da prévia.` : "")
    );
    setMotivo("");
    setAcordosEscolhidos(new Set());
    carregar();
  }

  if (carregando) return <Carregando tema="escuro" />;
  if (erro) return <Erro texto={erro} onTentar={carregar} tema="escuro" />;

  const selecao = [...selecionados];

  return (
    <div style={pagina}>
      <h1 style={titulo}>Carteira Geral</h1>
      <p style={subtitulo}>
        Destino de gestão. O que está aqui não é pego por rotina automática e nenhum operador
        consegue assumir sozinho — só sai por esta tela. Para devolver à operação, mande para a{" "}
        <strong>fila livre</strong>.
      </p>

      {/* ---------------- painel ---------------- */}
      <div style={grade}>
        <Bloco titulo="Total no filtro" valor={moeda(painel?.total_valor)} nota={`${painel?.total_alunos || 0} alunos`} />
        <Bloco titulo="Mensalidade" valor={moeda(painel?.total_mensalidade)} />
        <Bloco titulo="Acordo" valor={moeda(painel?.total_acordo)} />
        <Bloco
          titulo="Sem operador"
          valor={moeda(painel?.sem_operador?.valor)}
          nota={`${painel?.sem_operador?.alunos || 0} alunos`}
          alerta
        />
        <Bloco
          titulo="Responsável não é operador ativo"
          valor={moeda(painel?.responsavel_inativo?.valor)}
          nota={`${painel?.responsavel_inativo?.alunos || 0} alunos`}
          alerta
        />
        <Bloco
          titulo="Já na Carteira Geral"
          valor={moeda(painel?.na_carteira_geral?.valor)}
          nota={`${painel?.na_carteira_geral?.alunos || 0} alunos`}
        />
      </div>

      <section style={cartao}>
        <h2 style={secao}>Por ano de vencimento</h2>
        <p style={nota}>
          O valor por ano soma o total. A contagem de alunos, não: quem deve em 2025 e em 2026
          aparece nos dois anos.
        </p>
        <table style={tabela}>
          <thead>
            <tr>
              <th style={th}>Ano</th>
              <th style={thNum}>Mensalidade</th>
              <th style={thNum}>Acordo</th>
              <th style={thNum}>Total</th>
              <th style={thNum}>Títulos/parcelas</th>
            </tr>
          </thead>
          <tbody>
            {porAno.map((l) => (
              <tr key={l.ano}>
                <td style={td}>{l.ano ?? "sem data"}</td>
                <td style={tdNum}>{moeda(l.mensalidade)}</td>
                <td style={tdNum}>{moeda(l.acordo)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{moeda(l.valor)}</td>
                <td style={tdNum}>{l.itens}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={cartao}>
        <h2 style={secao}>Por responsável</h2>
        <table style={tabela}>
          <thead>
            <tr>
              <th style={th}>Responsável</th>
              <th style={th}>Situação</th>
              <th style={thNum}>Alunos</th>
              <th style={thNum}>Mensalidade</th>
              <th style={thNum}>Acordo</th>
              <th style={thNum}>Total</th>
            </tr>
          </thead>
          <tbody>
            {(painel?.por_responsavel || []).map((r) => (
              <tr key={r.email || r.classe}>
                <td style={td}>{r.nome}</td>
                <td style={{ ...td, color: classeEmAlerta(r.classe) ? "var(--rv-ambar-texto)" : "var(--rv-texto-fraco)" }}>
                  {rotuloClasse(r.classe)}
                </td>
                <td style={tdNum}>{r.alunos}</td>
                <td style={tdNum}>{moeda(r.mensalidade)}</td>
                <td style={tdNum}>{moeda(r.acordo)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{moeda(r.valor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ---------------- filtros ---------------- */}
      <section style={cartao}>
        <h2 style={secao}>Filtrar</h2>
        <div style={linhaFiltros}>
          <label style={campo}>
            <span style={rotulo}>Responsável</span>
            <select
              value={filtros.responsavel}
              onChange={(e) => setFiltros({ ...filtros, responsavel: e.target.value })}
              style={input}
            >
              <option value="">Todos</option>
              <option value="SEM_OPERADOR">Sem operador</option>
              <option value="SEM_DONO_ATIVO">Sem operador ativo (inclui inativo e fora da fila)</option>
              <option value="CARTEIRA_GERAL">Carteira Geral</option>
              {operadores.map((o) => (
                <option key={o.email} value={o.email}>
                  {o.nome}
                  {o.recebe_novos_casos === false ? " (fechada para casos novos)" : ""}
                </option>
              ))}
            </select>
          </label>

          <label style={campo}>
            <span style={rotulo}>Ano de vencimento</span>
            <select value={filtros.ano} onChange={(e) => setFiltros({ ...filtros, ano: e.target.value })} style={input}>
              <option value="">Todos</option>
              {porAno.map((l) => (
                <option key={l.ano} value={l.ano ?? ""}>
                  {l.ano ?? "sem data"}
                </option>
              ))}
            </select>
          </label>

          <label style={campo}>
            <span style={rotulo}>Tipo de dívida</span>
            <select value={filtros.tipo} onChange={(e) => setFiltros({ ...filtros, tipo: e.target.value })} style={input}>
              <option value="">Mensalidade e acordo</option>
              <option value="MENSALIDADE">Somente mensalidade</option>
              <option value="ACORDO">Somente acordo</option>
            </select>
          </label>

          <label style={campo}>
            <span style={rotulo}>Nome, CPF ou matrícula</span>
            <input
              value={filtros.busca}
              onChange={(e) => setFiltros({ ...filtros, busca: e.target.value })}
              style={input}
              placeholder="buscar"
            />
          </label>
        </div>
      </section>

      {/* ---------------- lista ---------------- */}
      <section style={cartao}>
        <h2 style={secao}>
          Selecionar <span style={nota}>({selecao.length} de {lista.length} nesta página)</span>
        </h2>

        {lista.length === 0 ? (
          <Vazio texto="Nenhum aluno com este filtro." tema="escuro" />
        ) : (
          <table style={tabela}>
            <thead>
              <tr>
                <th style={th}>
                  <input
                    type="checkbox"
                    aria-label="Selecionar todos"
                    checked={selecao.length === lista.length && lista.length > 0}
                    onChange={alternarTodos}
                  />
                </th>
                <th style={th}>Aluno</th>
                <th style={th}>Responsável</th>
                <th style={thNum}>Mensalidade</th>
                <th style={thNum}>Acordo</th>
                <th style={thNum}>Total</th>
                <th style={thNum}>Acordos</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((l) => (
                <tr key={l.aluno_id}>
                  <td style={td}>
                    <input
                      type="checkbox"
                      aria-label={`Selecionar ${l.nome}`}
                      checked={selecionados.has(l.aluno_id)}
                      onChange={() => alternar(l.aluno_id)}
                    />
                  </td>
                  <td style={td}>{l.nome}</td>
                  <td style={{ ...td, color: classeEmAlerta(l.dono_classe) ? "var(--rv-ambar-texto)" : undefined }}>
                    {l.dono_classe === "SEM_OPERADOR" ? "Sem operador" : l.dono_nome || l.dono_email}
                  </td>
                  <td style={tdNum}>{moeda(l.saldo_mensalidade)}</td>
                  <td style={tdNum}>{moeda(l.saldo_acordo)}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{moeda(l.saldo_total)}</td>
                  <td style={tdNum}>
                    {l.acordos_vivos || 0}
                    {l.acordos_de_outro_dono ? ` (${l.acordos_de_outro_dono} de outro dono)` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ---------------- movimentar ---------------- */}
      <section style={cartao}>
        <h2 style={secao}>Movimentar em lote</h2>

        <div style={linhaFiltros}>
          <label style={campo}>
            <span style={rotulo}>Destino</span>
            <select value={destinoTipo} onChange={(e) => { setDestinoTipo(e.target.value); setPrevia(null); }} style={input}>
              {DESTINOS.map((d) => (
                <option key={d.valor} value={d.valor}>
                  {d.rotulo}
                </option>
              ))}
            </select>
            <span style={nota}>{DESTINOS.find((d) => d.valor === destinoTipo)?.ajuda}</span>
          </label>

          {destinoTipo === "OPERADOR" && (
            <label style={campo}>
              <span style={rotulo}>Operador</span>
              <select value={destinoEmail} onChange={(e) => { setDestinoEmail(e.target.value); setPrevia(null); }} style={input}>
                <option value="">Selecione…</option>
                {operadores.map((o) => (
                  <option key={o.email} value={o.email}>
                    {o.nome}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label style={{ ...campo, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={moverAcordos}
              onChange={(e) => { setMoverAcordos(e.target.checked); setPrevia(null); }}
            />
            <span style={rotulo}>Levar os acordos do próprio dono</span>
          </label>
        </div>

        <p style={nota}>
          Esta opção vale só para os acordos <strong>do dono do caso</strong>. Desmarcar deixa o
          acordo com ele — e, quando o aluno não tem mensalidade em aberto, o sistema realinha a
          ficha ao dono do acordo ativo, ou seja, o aluno volta para o responsável antigo.
          <br />
          <strong>Acordo de terceiro nunca vai junto por padrão.</strong> Ele aparece um a um na
          prévia e só se move se você marcar.
        </p>

        <label style={{ ...campo, maxWidth: 640 }}>
          <span style={rotulo}>Motivo (fica na auditoria)</span>
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            style={{ ...input, minHeight: 64 }}
            placeholder="Ex.: saída da Olga — carteira recolhida para redistribuição."
          />
        </label>

        <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          <button type="button" onClick={gerarPrevia} disabled={ocupado || selecao.length === 0} style={botao}>
            {ocupado ? "Calculando…" : `Ver prévia de ${selecao.length} aluno(s)`}
          </button>
          <button
            type="button"
            onClick={confirmar}
            disabled={ocupado || !previa?.previa_id}
            style={{ ...botao, background: previa?.previa_id ? "var(--rv-verde-ok-fundo)" : "#374151" }}
          >
            Confirmar remanejamento
          </button>
        </div>

        {aviso && <p style={avisoTexto}>{aviso}</p>}
      </section>

      {/* ---------------- prévia ---------------- */}
      {previa && (
        <section style={{ ...cartao, borderLeft: "4px solid var(--rv-azul)" }}>
          <h2 style={secao}>Prévia — nada foi movido ainda</h2>

          <div style={grade}>
            <Bloco titulo="Alunos" valor={String(previa.total_alunos)} />
            <Bloco titulo="Acordos que vão junto" valor={String(previa.total_acordos)} />
            <Bloco
              titulo="Acordos de terceiros"
              valor={`${previa.acordos_de_terceiros_selecionados || 0} de ${previa.acordos_de_terceiros || 0}`}
              nota="só por seleção"
              alerta={Number(previa.acordos_de_terceiros || 0) > 0}
            />
            <Bloco titulo="Retornos preservados" valor={String(previa.retornos_preservados || 0)} />
            <Bloco titulo="Valor total" valor={moeda(previa.total_valor)} />
            <Bloco titulo="Destino" valor={previa.destino_nome} />
          </div>

          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 12 }}>
            <div>
              <h3 style={secaoMenor}>O que muda</h3>
              <ul style={listaTexto}>
                {O_QUE_MUDA.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 style={secaoMenor}>O que não muda</h3>
              <ul style={listaTexto}>
                {O_QUE_NAO_MUDA.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </div>

          {terceiros.length > 0 && (
            <>
              <h3 style={secaoMenor}>
                Acordos de terceiros ({previa.acordos_de_terceiros_selecionados} de{" "}
                {previa.acordos_de_terceiros} selecionados)
              </h3>
              <p style={nota}>
                Cada um destes acordos é de outra pessoa. Marque só os que devem acompanhar o
                aluno; os demais ficam com quem os negociou. Marcar ou desmarcar refaz a prévia.
              </p>
              <table style={tabela}>
                <thead>
                  <tr>
                    <th style={th}>Levar</th>
                    <th style={th}>Acordo</th>
                    <th style={th}>Aluno</th>
                    <th style={th}>Responsável hoje</th>
                    <th style={th}>Status</th>
                    <th style={thNum}>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {terceiros.map((t) => (
                    <tr key={t.acordo_id}>
                      <td style={td}>
                        <input
                          type="checkbox"
                          aria-label={`Levar acordo ${t.numero} de ${t.aluno}`}
                          checked={acordosEscolhidos.has(t.acordo_id)}
                          onChange={() => alternarAcordo(t.acordo_id)}
                        />
                      </td>
                      <td style={td}>{t.numero || "sem número"}</td>
                      <td style={td}>{t.aluno}</td>
                      <td style={td}>{t.de_email || "ninguém"}</td>
                      <td style={td}>{t.status}</td>
                      <td style={tdNum}>{moeda(t.valor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" onClick={gerarPrevia} disabled={ocupado} style={{ ...botao, marginTop: 10 }}>
                Recalcular prévia com esta seleção
              </button>
            </>
          )}

          <h3 style={secaoMenor}>Conflitos e avisos</h3>
          {conflitos.length === 0 ? (
            <p style={nota}>Nenhum conflito nesta seleção.</p>
          ) : (
            <table style={tabela}>
              <thead>
                <tr>
                  <th style={th}>Aviso</th>
                  <th style={thNum}>Casos</th>
                  <th style={th}>Exemplos</th>
                </tr>
              </thead>
              <tbody>
                {conflitos.map((c) => (
                  <tr key={c.tipo}>
                    <td style={td}>{c.rotulo}</td>
                    <td style={tdNum}>{c.total}</td>
                    <td style={{ ...td, color: "var(--rv-texto-fraco)", fontSize: 12 }}>
                      {c.exemplos.join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

function Bloco({ titulo, valor, nota: rodape, alerta }) {
  return (
    <div style={{ ...bloco, borderLeft: `3px solid ${alerta ? "var(--rv-ambar-texto)" : "var(--rv-azul)"}` }}>
      <span style={blocoTitulo}>{titulo}</span>
      <strong style={blocoValor}>{valor}</strong>
      {rodape && <span style={nota}>{rodape}</span>}
    </div>
  );
}

const pagina = { padding: "24px", color: "var(--rv-texto)", maxWidth: 1400, margin: "0 auto" };
const titulo = { fontSize: 24, fontWeight: 800, margin: "0 0 4px" };
const subtitulo = { margin: "0 0 20px", color: "var(--rv-texto-fraco)", maxWidth: 820, lineHeight: 1.5 };
const cartao = { ...cartaoEscuro, borderRadius: 12, padding: 16, marginBottom: 16 };
const secao = { fontSize: 16, fontWeight: 700, margin: "0 0 4px" };
const secaoMenor = { fontSize: 14, fontWeight: 700, margin: "16px 0 6px" };
const nota = { fontSize: 12, color: "var(--rv-texto-fraco)", display: "block", margin: "0 0 10px" };
const grade = { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 };
const bloco = { ...cartaoEscuro, borderRadius: 10, padding: "10px 14px", minWidth: 170, display: "flex", flexDirection: "column", gap: 2 };
const blocoTitulo = { fontSize: 12, color: "var(--rv-texto-fraco)", fontWeight: 600 };
const blocoValor = { fontSize: 18, fontWeight: 800 };
const tabela = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const th = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #374151", fontSize: 12, color: "var(--rv-texto-fraco)" };
const thNum = { ...th, textAlign: "right" };
const td = { padding: "6px 8px", borderBottom: "1px solid #1f2937" };
const tdNum = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const linhaFiltros = { display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" };
const campo = { display: "flex", flexDirection: "column", gap: 4, minWidth: 220 };
const rotulo = { fontSize: 12, fontWeight: 600, color: "var(--rv-texto-fraco)" };
const input = { padding: "7px 9px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#f3f4f6", boxSizing: "border-box" };
const botao = { padding: "9px 16px", borderRadius: 8, border: "none", background: "var(--rv-azul)", color: "#fff", fontWeight: 700, cursor: "pointer" };
const avisoTexto = { marginTop: 12, fontSize: 13, color: "var(--rv-ambar-texto)" };
const listaTexto = { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: "var(--rv-texto-fraco)" };
