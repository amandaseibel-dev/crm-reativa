// Aba Remessas do Preventivo.
//
// A REMESSA É A UNIDADE DE TRABALHO. Cada ação preventiva começa com um
// arquivo novo, importado na hora — a remessa anterior nunca vira carteira
// ativa sozinha. Por isso esta aba não termina na importação: ela termina no
// RESUMO DA REMESSA, com os três botões que continuam o trabalho
// (Atualizar dados · Gerar WhatsApp · Gerar E-mail).
//
// Fluxo, na ordem: escolher arquivo → nomear a remessa → conferir o mapeamento
// das colunas → PRÉVIA → confirmar → resumo da remessa.
//
// A prévia e a confirmação mandam as MESMAS linhas para o banco, e lá rodam a
// mesma função de validação — a prévia não pode prometer um resultado que a
// confirmação não cumpra.
//
// Este importador é independente do da cobrança (`/importacoes`,
// `/importar-acordos`): outro arquivo, outra chave, outro destino, e nenhuma
// escrita em tabela da cobrança.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../services/supabase";
import { S } from "../../ui/estilosFila";
import { moeda, dataHora } from "../../utils/preventivoFormato";
import {
  CAMPOS, sugerirMapeamento, camposObrigatoriosFaltando, linhaParaRegistro,
  decodificar, lerCsv,
} from "../../utils/preventivo";

const CDN_XLSX = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

const MOTIVOS = {
  SEM_MATRICULA: "sem matrícula do aluno",
  SEM_DOCUMENTO: "sem identificador do título",
  SEM_NOME: "sem nome do aluno",
  VENCIMENTO_INVALIDO: "vencimento ausente ou ilegível",
  VALOR_INVALIDO: "valor ausente, zerado ou negativo",
  FORA_DO_PERIODO: "vencimento fora da janela desta carteira",
  DUPLICADA_NO_ARQUIVO: "linha repetida no próprio arquivo",
  DOCUMENTO_EM_OUTRA_MATRICULA: "o mesmo título já está em outra matrícula nesta carteira",
};

export default function AbaImportacoes({ carteira, aoImportar, onIr }) {
  // o estado já nasce certo quando a biblioteca veio de outra tela — evita
  // um setState síncrono dentro do efeito só para descobrir isso.
  const [libOk, setLibOk] = useState(() => typeof window !== "undefined" && !!window.XLSX);
  const [erro, setErro] = useState("");
  const [arquivo, setArquivo] = useState("");
  const [cabecalho, setCabecalho] = useState([]);
  const [linhas, setLinhas] = useState([]);
  const [mapa, setMapa] = useState({});
  const [nomeLote, setNomeLote] = useState("");
  const [previa, setPrevia] = useState(null);
  const [ocupado, setOcupado] = useState("");
  const [remessas, setRemessas] = useState([]);
  const [remessaNova, setRemessaNova] = useState(null);
  const [atualizando, setAtualizando] = useState(false);
  const [situacao, setSituacao] = useState(null);

  useEffect(() => {
    if (window.XLSX) return;
    const s = document.createElement("script");
    s.src = CDN_XLSX;
    s.onload = () => setLibOk(true);
    s.onerror = () => setErro("Não consegui carregar a biblioteca de leitura de planilha.");
    document.body.appendChild(s);
  }, []);

  useEffect(() => {
    let vivo = true;
    Promise.all([
      supabase.rpc("preventivo_remessas", { p_carteira_id: carteira.id }),
      supabase.rpc("preventivo_sinc_situacao", { p_carteira_id: carteira.id }),
    ]).then(([r, s2]) => {
      if (!vivo) return;
      setRemessas(r.data || []);
      if (!s2.error) setSituacao(s2.data);
    });
    return () => { vivo = false; };
  }, [carteira.id, previa]);

  const faltando = useMemo(() => camposObrigatoriosFaltando(mapa), [mapa]);

  async function aoEscolher(e) {
    setErro(""); setPrevia(null);
    const f = e.target.files?.[0];
    if (!f) return;
    setArquivo(f.name);
    if (!nomeLote) setNomeLote(f.name.replace(/\.[^.]+$/, ""));
    try {
      const buf = await f.arrayBuffer();
      let linhasCruas;
      if (/\.csv$/i.test(f.name)) {
        // CSV vai por leitor próprio: o relatório real vem em LATIN-1 e tem
        // ponto e vírgula dentro de campo entre aspas.
        linhasCruas = lerCsv(decodificar(buf));
      } else {
        const wb = window.XLSX.read(buf, { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        linhasCruas = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
      }
      const cab = (linhasCruas[0] || []).map((c) => String(c ?? ""));
      const corpo = linhasCruas.slice(1).filter((l) => l.some((c) => c !== null && c !== undefined && c !== ""));
      setCabecalho(cab);
      setLinhas(corpo);
      setMapa(sugerirMapeamento(cab));
    } catch {
      setErro("Não consegui ler o arquivo. Ele precisa ser .xlsx, .xls ou .csv com uma linha de cabeçalho.");
    }
  }

  const registros = useMemo(
    () => linhas.map((l) => linhaParaRegistro(l, mapa)),
    [linhas, mapa]);

  async function verPrevia() {
    setErro(""); setOcupado("previa");
    const { data, error } = await supabase.rpc("preventivo_lote_previa", {
      p_carteira_id: carteira.id, p_linhas: registros,
    });
    setOcupado("");
    if (error) { setErro(error.message); return; }
    setPrevia({ ...data, confirmado: false });
  }

  async function confirmar() {
    setErro(""); setOcupado("confirmar");
    const { data, error } = await supabase.rpc("preventivo_lote_confirmar", {
      p_carteira_id: carteira.id,
      p_nome: nomeLote.trim(),
      p_arquivo: arquivo,
      p_mapeamento: mapa,
      p_conteudo_hash: null,
      p_linhas: registros,
    });
    setOcupado("");
    if (error) { setErro(error.message); return; }
    setPrevia({ ...data, confirmado: true });
    aoImportar?.();
    if (data?.lote_id) {
      const { data: r } = await supabase.rpc("preventivo_remessa_resumo", { p_lote_id: data.lote_id });
      setRemessaNova(r);
    }
  }

  // ATUALIZAR DADOS. Só quando a gestão pede — não existe cron, por decisão.
  // Não chama nada de pagamento: consulta o Prime e registra alteração de
  // valor na fonte.
  async function atualizarDados() {
    setErro(""); setAtualizando(true);
    try {
      let sincId = null;
      for (let volta = 0; volta < 40; volta++) {
        const { data, error } = await supabase.functions.invoke("prev-sincronizar", {
          body: sincId ? { sinc_id: sincId } : { carteira_id: carteira.id, origem: "manual" },
        });
        if (error) throw error;
        sincId = data?.sinc_id;
        if (data?.concluido) break;
      }
    } catch (e) {
      setErro("Não consegui concluir a atualização com o Prime agora. Os valores anteriores continuam válidos. " + (e?.message || ""));
    }
    setAtualizando(false);
    const [{ data: s2 }, { data: r }] = await Promise.all([
      supabase.rpc("preventivo_sinc_situacao", { p_carteira_id: carteira.id }),
      supabase.rpc("preventivo_remessas", { p_carteira_id: carteira.id }),
    ]);
    setSituacao(s2); setRemessas(r || []);
  }

  return (
    <div style={S.cards}>
      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      <div style={{ ...S.card, padding: 20 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>1. Escolher o arquivo</h2>
        <p style={{ ...S.muted, marginTop: 6 }}>
          O relatório precisa trazer, no mínimo: <strong>matrícula</strong> (a coluna
          {" "}<em>Código</em> do relatório de inadimplência), <strong>nome</strong>,
          {" "}<strong>vencimento</strong> e <strong>saldo em aberto</strong>. Um arquivo só
          com nome e telefone não é carteira financeira.
          <br />
          O relatório de inadimplência da ULBRA <strong>não traz identificador de título</strong>.
          Sem ele, cada linha é ligada ao Prime por matrícula + vencimento atual; onde houver
          mais de um candidato, o título fica pendente em vez de ser ligado no chute.
        </p>
        <input type="file" accept=".xlsx,.xls,.csv" disabled={!libOk} onChange={aoEscolher}
               style={{ marginTop: 12 }} />
        {arquivo ? <p style={{ ...S.muted, marginTop: 8 }}>{arquivo} — {linhas.length} linhas</p> : null}
      </div>

      {cabecalho.length > 0 && (
        <>
          <div style={{ ...S.card, padding: 20 }}>
            <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>2. Nomear o lote</h2>
            <p style={{ ...S.muted, marginTop: 6 }}>
              O nome identifica esta remessa. Reimportar o mesmo arquivo em outro lote
              não duplica título nem valor — o consolidado conta por título.
            </p>
            <input style={{ ...S.input, marginTop: 10 }} value={nomeLote}
                   onChange={(e) => setNomeLote(e.target.value)} placeholder="Ex.: Remessa 01/10" />
          </div>

          <div style={{ ...S.card, padding: 20 }}>
            <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>3. Conferir as colunas</h2>
            <p style={{ ...S.muted, marginTop: 6 }}>
              O sistema chuta pelo cabeçalho; você confirma. O nome do aluno nunca é
              usado para identificar o título.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10, marginTop: 12 }}>
              {CAMPOS.map((c) => (
                <div key={c.id}>
                  <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>
                    {c.rotulo}{c.obrigatorio ? " *" : ""}
                  </label>
                  <select
                    style={{ ...S.select, width: "100%" }}
                    value={mapa[c.id] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      const novo = { ...mapa };
                      if (v === "") delete novo[c.id]; else novo[c.id] = Number(v);
                      setMapa(novo);
                    }}
                  >
                    <option value="">— não usar —</option>
                    {cabecalho.map((h, i) => <option key={i} value={i}>{h || `coluna ${i + 1}`}</option>)}
                  </select>
                </div>
              ))}
            </div>
            {faltando.length > 0 && (
              <div style={{ ...S.erroBox, marginTop: 14, marginBottom: 0 }}>
                Falta apontar: {faltando.join(", ")}.
              </div>
            )}
          </div>

          <div style={{ ...S.card, padding: 20 }}>
            <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>4. Prévia</h2>
            <p style={{ ...S.muted, marginTop: 6 }}>
              A prévia não grava nada. Ela roda exatamente a mesma validação da
              confirmação.
            </p>
            <button onClick={verPrevia} disabled={faltando.length > 0 || ocupado === "previa"}
                    style={{ ...S.btnGhost, marginTop: 12, opacity: faltando.length > 0 ? 0.5 : 1 }}>
              {ocupado === "previa" ? "Conferindo…" : "Ver prévia"}
            </button>
          </div>
        </>
      )}

      {previa && (
        <div style={{ ...S.card, padding: 20 }}>
          <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>
            {previa.confirmado ? "Importação concluída" : "5. O que vai entrar"}
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12, marginTop: 14 }}>
            <Numero rotulo="Alunos" valor={previa.alunos} />
            <Numero rotulo="Títulos" valor={previa.titulos} />
            <Numero rotulo="Valor total" valor={moeda(previa.valor_total)} />
            <Numero rotulo="Novos" valor={previa.novos} />
            <Numero rotulo="Atualizações" valor={previa.atualizados} />
            <Numero rotulo="Linhas recusadas" valor={previa.linhas_recusadas} />
            <Numero rotulo="Já fora da janela de 31 dias" valor={previa.fora_da_janela} />
            <Numero rotulo="Sem celular válido" valor={previa.sem_celular_valido} />
            <Numero rotulo="Mais de um celular na linha" valor={previa.celular_ambiguo} />
            <Numero rotulo="Sem e-mail válido" valor={previa.sem_email_valido} />
            <Numero rotulo="Mais de um e-mail na linha" valor={previa.email_multiplo} />
            <Numero rotulo="Celular repetido entre alunos" valor={previa.celular_compartilhado} />
            <Numero rotulo="Sem identificador de título no arquivo" valor={previa.sem_identificador_de_titulo} />
          </div>

          {Object.keys(previa.recusas_por_motivo || {}).length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ ...S.cardResumo, margin: "0 0 6px" }}>Por que cada linha foi recusada</h3>
              <ul style={{ ...S.muted, margin: 0, paddingLeft: 18 }}>
                {Object.entries(previa.recusas_por_motivo).map(([m, n]) => (
                  <li key={m}>{n} — {MOTIVOS[m] || m}</li>
                ))}
              </ul>
              {previa.exemplos_recusa?.length > 0 && (
                <p style={{ ...S.muted, marginTop: 6, fontSize: 12 }}>
                  Primeiras linhas: {previa.exemplos_recusa.map((e) => `${e.linha}`).join(", ")}.
                </p>
              )}
            </div>
          )}

          {!previa.confirmado ? (
            <button onClick={confirmar} disabled={ocupado === "confirmar" || !nomeLote.trim()}
                    style={{ ...S.btnGhost, marginTop: 18 }}>
              {ocupado === "confirmar" ? "Importando…" : "Confirmar importação"}
            </button>
          ) : (
            <p style={{ ...S.muted, marginTop: 16 }}>
              Pronto. O próximo passo é a aba <strong>Resultados</strong>, para atualizar
              a situação financeira com o Prime.
            </p>
          )}
        </div>
      )}

      {remessaNova && <ResumoDaRemessa remessa={remessaNova} situacao={situacao}
                                        atualizando={atualizando}
                                        onAtualizar={atualizarDados} onIr={onIr} />}

      <div style={{ ...S.card, padding: 20 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Histórico de remessas</h2>
        <p style={{ ...S.muted, marginTop: 6 }}>
          Cada remessa é comparada com a anterior pela chave{" "}
          <strong>matrícula + vencimento atual + vencimento de origem</strong>.
        </p>
        {remessas.length === 0 ? (
          <p style={{ ...S.muted, marginTop: 8 }}>Nenhuma remessa importada ainda.</p>
        ) : (
          <table style={{ ...S.tabela, marginTop: 12 }}>
            <thead><tr>
              <th style={S.th}>Remessa</th><th style={S.th}>Importada em</th><th style={S.th}>Por</th>
              <th style={S.thNum}>Alunos</th><th style={S.thNum}>Títulos</th><th style={S.thNum}>Valor</th>
              <th style={S.thNum}>Continuam</th><th style={S.thNum}>Regularizados</th>
              <th style={S.thNum}>Novos</th><th style={S.thNum}>Ações</th>
            </tr></thead>
            <tbody>
              {remessas.map((r) => (
                <tr key={r.id}>
                  <td style={S.td}>{r.nome}</td>
                  <td style={S.td}>{dataHora(r.importada_em)}</td>
                  <td style={S.td}>{r.importada_por}</td>
                  <td style={S.tdNum}>{r.alunos}</td>
                  <td style={S.tdNum}>{r.titulos}</td>
                  <td style={S.tdNum}>{moeda(r.valor)}</td>
                  <td style={S.tdNum}>{r.comparacao?.primeira_remessa ? "—" : r.comparacao?.continua_em_aberto?.titulos}</td>
                  <td style={S.tdNum}>{r.comparacao?.primeira_remessa ? "—" : r.comparacao?.regularizados_entre_remessas?.titulos}</td>
                  <td style={S.tdNum}>{r.comparacao?.primeira_remessa ? "—" : r.comparacao?.novos_na_remessa?.titulos}</td>
                  <td style={S.tdNum}>{r.acoes?.length || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ ...S.muted, marginTop: 10, fontSize: 12 }}>
          <strong>Regularizados entre remessas</strong> = título que estava na remessa
          anterior e deixou de aparecer no relatório seguinte. <strong>Não é pagamento
          confirmado</strong>: pode ser pagamento, cancelamento, renegociação, bolsa ou
          mudança do recorte do relatório — a fonte não distingue.
        </p>
      </div>
    </div>
  );
}

// O RESUMO DA REMESSA. É onde o trabalho continua depois de importar.
function ResumoDaRemessa({ remessa, situacao, atualizando, onAtualizar, onIr }) {
  const completa = situacao?.ultima_completa;
  return (
    <div style={{ ...S.card, padding: 20, borderLeft: "4px solid var(--rv-azul)" }}>
      <h2 style={{ ...S.cardNome, fontSize: 17, margin: 0 }}>Remessa {remessa.nome}</h2>
      <p style={{ ...S.muted, marginTop: 4 }}>
        Importada em {dataHora(remessa.importada_em)} por {remessa.importada_por}.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12, marginTop: 14 }}>
        <Numero rotulo="Alunos" valor={remessa.alunos} />
        <Numero rotulo="Títulos" valor={remessa.titulos} />
        <Numero rotulo="Valor da remessa" valor={moeda(remessa.valor)} />
        <Numero rotulo="WhatsApp disponível" valor={remessa.whatsapp_disponivel} />
        <Numero rotulo="E-mail disponível" valor={remessa.email_disponivel} />
        <Numero rotulo="Registros para revisão" valor={remessa.para_revisao} />
      </div>

      <div style={{ ...S.barra, marginTop: 18 }}>
        <button style={S.btnGhost} disabled={atualizando} onClick={onAtualizar}>
          {atualizando ? "Consultando o Prime…" : "Atualizar dados"}
        </button>
        <button style={S.btnGhost} onClick={() => onIr?.("acoes")}>Gerar WhatsApp</button>
        <button style={S.btnGhost} onClick={() => onIr?.("acoes")}>Gerar E-mail</button>
      </div>

      <p style={{ ...S.muted, marginTop: 12, fontSize: 12.5 }}>
        {completa
          ? `Última atualização com o Prime: ${dataHora(completa.concluido_em)} — ${completa.consultados} de ${completa.alvos} alunos consultados.`
          : "Esta carteira ainda não foi atualizada com o Prime."}
        {situacao?.titulos_nunca_sincronizados > 0
          ? ` ${situacao.titulos_nunca_sincronizados} título(s) ainda não foram localizados no Prime.`
          : ""}
        {" "}A atualização é manual, por decisão: não existe rotina automática.
      </p>
    </div>
  );
}

function Numero({ rotulo, valor }) {
  return (
    <div style={{ background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "10px 14px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rv-texto-fraco)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{rotulo}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: "var(--rv-tinta)" }}>{valor ?? 0}</div>
    </div>
  );
}
