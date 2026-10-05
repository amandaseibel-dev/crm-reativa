import { useState, useEffect } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";
// IMPLEMENTACAO UNICA, compartilhada com Borderos.jsx. Hash diferente para o
// mesmo arquivo quebraria a idempotencia entre os dois fluxos em silencio --
// por isso nao ha copia local. Coberto por src/utils/hashArquivo.test.js.
import { hashArquivo } from "../utils/hashArquivo";
import { TIPOS_DE_ESCOPO, escopoTipoPermitido, motivoDoBloqueio, scopeKeyRelatorio }
  from "../utils/escopoExtracao";

// Importacao do "Relatorio de Titulos em Aberto" (somente acordos).
// Le o arquivo no navegador, mostra previa e grava via RPC importar_acordos,
// que cria alunos faltantes (match por CPF), insere titulos vinculados e
// popula a fila de confirmacao de acordos para a operacao acompanhar.
//
// J3/I1: alem do fluxo financeiro (inalterado), registra a PRESENCA de TODAS as
// linhas do arquivo -- inclusive as mensalidades, que antes eram descartadas no
// `continue` abaixo. A presenca e o unico registro de que o titulo ESTAVA no
// relatorio naquela extracao. Nao e usada para nenhuma inferencia: ausencia
// entre extracoes NAO prova incorporacao a acordo (ver docs/J3-*).

function soDigitos(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }

function parseData(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, "0"), d = String(v.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return m[3] + "-" + m[2] + "-" + m[1];
  return null;
}

function parseValor(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/\./g, "").replace(",", ".").replace(/[^0-9.-]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function moeda(n) {
  return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dataHora(v) {
  if (!v) return "-";
  const d = new Date(v);
  if (isNaN(d)) return "-";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ImportacaoAcordos() {
  const [linhas, setLinhas] = useState(null);
  const [resumo, setResumo] = useState(null);
  const [erro, setErro] = useState("");
  const [importando, setImportando] = useState(false);
  const [progresso, setProgresso] = useState("");
  const [resultado, setResultado] = useState(null);
  const [nomeArquivo, setNomeArquivo] = useState("");
  const [historico, setHistorico] = useState(null);
  // J3/I1 — declaracao de escopo. OBRIGATORIA: sem ela nao da para comparar
  // duas extracoes. "" forca a escolha explicita (nao tem default silencioso).
  const [completude, setCompletude] = useState("");
  const [confirmouTotal, setConfirmouTotal] = useState(false);
  const [snapshotAt, setSnapshotAt] = useState("");
  // presenca do arquivo BRUTO + metadados do arquivo
  // ---- escopo declarado (I2, 01/10): a scope_key era fixa no codigo como
  // "PORTADOR=195|BORDERO=TODOS|TIPO=TODOS". Qualquer extracao filtrada entrava
  // na mesma sequencia da extracao completa. Agora e declarada -- e o conteudo
  // do arquivo restringe o que pode ser declarado.
  const [portador, setPortador] = useState("195");
  const [escopoBordero, setEscopoBordero] = useState("TODOS");
  const [escopoTipo, setEscopoTipo] = useState("");
  const [tiposNoArquivo, setTiposNoArquivo] = useState([]);
  const [presenca, setPresenca] = useState(null);
  const [arquivoHash, setArquivoHash] = useState("");
  const [linhasArquivo, setLinhasArquivo] = useState(0);

  async function carregarHistorico() {
    const { data, error } = await supabase.rpc("listar_importacoes_acordos");
    if (!error) setHistorico(data || []);
  }

  useEffect(() => { carregarHistorico(); }, []);

  function analisar(e) {
    setErro(""); setResultado(null); setResumo(null); setLinhas(null);
    setPresenca(null); setArquivoHash(""); setLinhasArquivo(0);
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setNomeArquivo(file.name);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        setArquivoHash(await hashArquivo(ev.target.result));
        const wb = XLSX.read(new Uint8Array(ev.target.result), { type: "array", cellDates: true });
        const sh = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sh, { defval: "" });
        setLinhasArquivo(rows.length);   // TOTAL de linhas, nao o subconjunto
        const out = [];
        const todas = [];                // J3/I1: presenca, ANTES de filtrar
        for (const r of rows) {
          const tipo = String(r["Tipo de Boleto"] || "").trim();
          const doc = soDigitos(r["Documento"]);
          if (!/^\d{6,}$/.test(doc)) continue;               // ignora linha de total
          // ===== CONTRATO (nao mover) =====================================
          // A captura de presenca deve permanecer ANTES de qualquer filtro
          // operacional do importador. Mover esta linha para depois do
          // `continue` abaixo faz as mensalidades sumirem do registro, e a
          // ausencia delas vira artefato do CRM -- nao do relatorio da ULBRA.
          // ================================================================
          // PRESENCA: toda linha com documento valido entra, qualquer tipo.
          todas.push({
            documento: doc,
            cpf: soDigitos(r["CPF Aluno"]),
            tipo_boleto: tipo,
            situacao: String(r["Situação do Aluno"] || "").trim(),
            valor: parseValor(r["A Receber Bruto"]),
            venc: parseData(r["Vcto"]),
          });
          // FLUXO FINANCEIRO: daqui para baixo, identico ao de hoje.
          if (tipo.toLowerCase() !== "acordo") continue;   // so acordos
          out.push({
            documento: doc,
            cpf: soDigitos(r["CPF Aluno"]),
            nome: String(r["Titular"] || "").trim(),
            venc: parseData(r["Vcto"]),
            valor: parseValor(r["A Receber Bruto"]),
            unidade: String(r["Estabelecimento"] || "").trim(),
            situacao: String(r["Situação do Aluno"] || "").trim(),
          });
        }
        setPresenca(todas);
        // TIPOS PRESENTES NO ARQUIVO. Base da restricao da declaracao: a
        // escolha manual deixa de ser a unica fonte do escopo.
        const tipos = [...new Set(todas.map((l) => l.tipo_boleto).filter(Boolean))];
        setTiposNoArquivo(tipos);
        // pre-seleciona a UNICA declaracao compativel com o conteudo, quando ha
        // uma. Nunca pre-seleciona TODOS por comodidade.
        const soAcordo = tipos.length > 0 && tipos.every((t) => t.toLowerCase() === "acordo");
        setEscopoTipo(soAcordo ? "ACORDO" : tipos.length >= 2 ? "" : "RECORTE");
        if (out.length === 0) { setErro("Nenhuma parcela de Acordo encontrada no arquivo. Confira se e o Relatorio de Titulos em Aberto."); return; }
        const cpfs = new Set(), bases = new Set();
        let total = 0;
        for (const o of out) {
          if (o.cpf) cpfs.add(o.cpf);
          bases.add(o.cpf + "|" + o.documento.slice(0, -2));
          total += Number(o.valor) || 0;
        }
        setLinhas(out);
        setResumo({ parcelas: out.length, cpfs: cpfs.size, acordos: bases.size, total });
      } catch (err) {
        setErro("Erro ao ler o arquivo: " + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function importar() {
    if (!linhas) return;
    // Trava: escopo tem de ser declarado ANTES de gravar. Nao ha default.
    if (completude !== "TOTAL" && completude !== "PARCIAL") {
      setErro("Declare se este arquivo e a extracao TOTAL do portador 195 ou um recorte PARCIAL.");
      return;
    }
    // TOTAL exige a confirmacao explicita do que TOTAL significa.
    if (completude === "TOTAL" && !confirmouTotal) {
      setErro("Confirme que a extracao foi feita sem filtro adicional, ou marque PARCIAL.");
      return;
    }
    if (!escopoTipoPermitido(escopoTipo, tiposNoArquivo)) {
      setErro("Declare o recorte de tipo de boleto compativel com o arquivo. " +
        "O arquivo tem " + tiposNoArquivo.length + " tipo(s) distinto(s): " +
        (tiposNoArquivo.join(", ") || "nenhum") + ".");
      return;
    }
    if (!/^[0-9]+$/.test(String(portador))) {
      setErro("Declare o portador da extracao.");
      return;
    }
    setImportando(true); setErro(""); setResultado(null);
    const importacaoId = crypto.randomUUID();
    const BATCH = 1200;
    const acc = { alunos_novos: 0, titulos_inseridos: 0, acordos_na_fila: 0, duplicados: 0, pulados: 0, linhasPuladas: 0 };
    try {
      for (let i = 0; i < linhas.length; i += BATCH) {
        const chunk = linhas.slice(i, i + BATCH);
        setProgresso("Gravando " + Math.min(i + BATCH, linhas.length) + " de " + linhas.length + "...");
        const { data, error } = await supabase.rpc("importar_acordos", { p_linhas: chunk, p_importacao_id: importacaoId });
        if (error) throw error;
        acc.alunos_novos += (data && data.alunos_novos) || 0;
        acc.titulos_inseridos += (data && data.titulos_inseridos) || 0;
        acc.acordos_na_fila += (data && data.acordos_na_fila) || 0;
        // Duplicidade nao barra mais a importacao (Amanda, 27/08/2026): o
        // acordo entra marcado e aparece aqui para conferencia.
        acc.duplicados = Math.max(acc.duplicados, (data && data.acordos_duplicados_sinalizados) || 0);
        // Quitados desta semana que a Prime ainda traz com divida: nao entram.
        acc.pulados += (data && data.cpfs_pulados_quitados) || 0;
        acc.linhasPuladas += (data && data.linhas_puladas_quitados) || 0;
      }
      setResultado({ ...acc, importacaoId });
      setProgresso("");

      // ---------------------------------------------------------------------
      // J3/I1 — PRESENCA. Depois do fluxo financeiro, em chamada separada e
      // transacao propria. Se falhar, a importacao financeira acima JA esta
      // concluida e intacta: a presenca e registro paralelo de auditoria, nunca
      // uma etapa da importacao. Por isso o try/catch que so avisa.
      // ---------------------------------------------------------------------
      try {
        // ---------------------------------------------------------------------
        // J3/I2 — CAPTURA EM LOTES.
        //
        // POR QUE (medido em producao em 01/10/2026):
        //   · uma extracao TOTAL real da carteira tem 47.949 linhas e 7 MB de
        //     payload;
        //   · `registrar_presenca_extracao` com as 47.949 de uma vez: 6.340 ms;
        //   · `authenticated` tem `statement_timeout = 8s`.
        // Sobravam 1.660 ms num dia bom -- ou seja, a chamada unica falha
        // justamente no unico caso que a trilha existe para registrar: o
        // snapshot TOTAL. Em lotes de 1.200 cada chamada custou 132 ms.
        //
        // O 1o lote continua indo por `registrar_presenca_extracao`: e ela que
        // cria o escopo e resolve a idempotencia por hash (funcao congelada do
        // I1, nao alterada). Os lotes seguintes vao por `extracao_lote_anexar`
        // e o `extracao_lote_fechar` recalcula as metricas e avalia.
        //
        // INTERRUPCAO NO MEIO E INERTE: entre o 1o lote e o fechamento o escopo
        // fica em TOTAL_PENDENTE_VALIDACAO, e `vw_titulo_presenca_historico` le
        // SOMENTE `TOTAL_VALIDADO`. Uma captura pela metade nao produz ausencia,
        // nao vira baseline e nao entra em comparacao.
        // ---------------------------------------------------------------------
        const LOTE_PRESENCA = 1200;
        const todas = presenca || [];
        const { data: pres, error: errPres } = await supabase.rpc("registrar_presenca_extracao", {
          p_importacao_id: importacaoId,
          p_source_type: "RELATORIO_TITULOS_ABERTO",
          // ESCOPO DECLARADO (I2, 01/10). Era fixo em
          // "PORTADOR=195|BORDERO=TODOS|TIPO=TODOS", o que punha extracao
          // filtrada e extracao completa na MESMA sequencia comparavel.
          // Agora cada dimensao que muda a populacao esperada entra na chave, e
          // `extracao_lote_fechar` confronta a declaracao com o conteudo antes
          // de deixar a extracao virar referencia.
          p_scope_key: scopeKeyRelatorio(portador, escopoBordero, escopoTipo),
          p_completude: completude,
          p_snapshot_at: snapshotAt ? new Date(snapshotAt).toISOString() : new Date().toISOString(),
          p_arquivo_nome: nomeArquivo || null,
          p_arquivo_hash: arquivoHash,
          p_linhas_arquivo: linhasArquivo,
          p_linhas: todas.slice(0, LOTE_PRESENCA),
        });
        if (errPres) {
          setProgresso("Importado. A presenca nao foi registrada: " + errPres.message);
        } else if (pres && pres.reaproveitado) {
          // Mesmo arquivo ja capturado: NAO anexa nem fecha. Sem esta saida, os
          // lotes seguintes cairiam no escopo ANTIGO e inflariam um snapshot
          // que ja estava encerrado.
          setProgresso("Importado. Este arquivo ja havia sido registrado (mesmo hash) -- presenca nao duplicada.");
        } else if (pres) {
          let fechado = null;
          for (let k = LOTE_PRESENCA; k < todas.length; k += LOTE_PRESENCA) {
            setProgresso("Importado. Registrando presenca: " +
              Math.min(k + LOTE_PRESENCA, todas.length) + " de " + todas.length + "...");
            const { error: errLote } = await supabase.rpc("extracao_lote_anexar", {
              p_escopo_id: pres.escopo_id,
              p_linhas: todas.slice(k, k + LOTE_PRESENCA),
            });
            if (errLote) {
              setProgresso("Importado. A presenca ficou incompleta (" + errLote.message +
                ") e por isso NAO sera usada como referencia.");
              fechado = "erro";
              break;
            }
          }
          if (fechado !== "erro") {
            const { data: fim, error: errFechar } = await supabase.rpc("extracao_lote_fechar", {
              p_escopo_id: pres.escopo_id,
            });
            setProgresso(errFechar
              ? "Importado. A presenca ficou incompleta (" + errFechar.message +
                ") e por isso NAO sera usada como referencia."
              : "Importado. Presenca registrada: " + (fim ? fim.linhas_capturadas : 0) +
                " linhas, estado " + (fim ? fim.estado : "-") + ".");
          }
        }
      } catch (e2) { setProgresso("Importado. Falha ao registrar presenca: " + (e2.message || e2)); }

      try {
        await supabase.rpc("registrar_importacao_acordo", {
          p_importacao_id: importacaoId,
          p_arquivo_nome: nomeArquivo || null,
          p_parcelas: resumo ? resumo.parcelas : linhas.length,
          p_acordos: resumo ? resumo.acordos : null,
          p_cpfs: resumo ? resumo.cpfs : null,
          p_alunos_novos: acc.alunos_novos,
          p_titulos_inseridos: acc.titulos_inseridos,
          p_total: resumo ? resumo.total : null,
        });
        carregarHistorico();
      } catch { /* histórico é secundário; não falha o import */ }
    } catch (err) {
      setErro("Erro na importacao: " + (err.message || err));
    } finally {
      setImportando(false);
    }
  }

  return (
    <div style={S.wrap}>
      <h1 style={S.titulo}>Importar Acordos</h1>
      <p style={S.sub}>Suba o <strong>Relatorio de Titulos em Aberto</strong> (somente acordos). O sistema vincula cada titulo ao aluno pelo CPF, cria alunos que ainda nao existem e monta a fila de confirmacao para a operacao acompanhar.</p>

      <div style={S.card}>
        <input type="file" accept=".xls,.xlsx" onChange={analisar} style={{ fontSize: 14 }} />
        {nomeArquivo && <span style={S.arq}>{nomeArquivo}</span>}
      </div>

      {/* J3/I1 — DECLARACAO OPERACIONAL DE ESCOPO.
          O sistema NAO tenta deduzir se o arquivo e TOTAL pelo nome nem pela
          quantidade de linhas: quem sabe o filtro aplicado na tela da ULBRA e
          quem extraiu. A contagem aparece so como apoio a conferencia -- nunca
          como critério automatico. */}
      {resumo && !resultado && (
        <div style={S.card}>
          <h2 style={S.h2}>Escopo desta extracao</h2>
          <p style={S.obs}>
            O arquivo tem <strong>{linhasArquivo.toLocaleString("pt-BR")}</strong> linhas.
            Esta contagem e so para a sua conferencia: o sistema nao decide o
            escopo por ela.
          </p>

          {/* ===== ESCOPO DECLARADO (I2) =====================================
               A `scope_key` sai daqui. As opcoes de tipo que o conteudo do
               arquivo nao sustenta ficam desabilitadas, com o motivo a vista --
               e `extracao_lote_fechar` reconfere no banco. */}
          <div style={S.boxEscopo}>
            <div style={S.linhaEscopo}>
              <label style={S.lblE}>Portador
                <select value={portador} onChange={(e) => setPortador(e.target.value)} style={S.inpE}>
                  <option value="195">195 — Reativa Cobranca</option>
                  <option value="202">202 — Reativa Cobranca Judicial</option>
                </select>
              </label>
              <label style={S.lblE}>Bordero no filtro
                <input value={escopoBordero} onChange={(e) => setEscopoBordero(e.target.value)}
                       style={S.inpE} placeholder="TODOS" />
              </label>
            </div>
            <div style={S.lblE}>Tipo de boleto no filtro</div>
            <div style={S.linhaEscopo}>
              {TIPOS_DE_ESCOPO.map((v) => {
                const permitido = escopoTipoPermitido(v, tiposNoArquivo);
                const motivo = motivoDoBloqueio(v, tiposNoArquivo);
                return (
                  <label key={v} style={{ ...S.rot, opacity: permitido ? 1 : 0.45 }}
                         title={motivo || ""}>
                    <input type="radio" name="escTipo" value={v} disabled={!permitido}
                      checked={escopoTipo === v} onChange={() => setEscopoTipo(v)} />
                    {" "}<strong>{v === "TODOS" ? "Sem filtro de tipo"
                        : v === "ACORDO" ? "Somente Acordo" : "Outro recorte"}</strong>
                    {!permitido && motivo ? <span style={S.obs}> — {motivo}</span> : null}
                  </label>
                );
              })}
            </div>
            <div style={S.obs}>
              Tipos de boleto encontrados no arquivo ({tiposNoArquivo.length}):{" "}
              {tiposNoArquivo.join(", ") || "nenhum"}.
            </div>
            <div style={S.obs}>
              Sequencia comparavel: <code>{scopeKeyRelatorio(portador, escopoBordero, escopoTipo || "?")}</code>
            </div>
          </div>

          <label style={S.rot}>
            <input type="radio" name="compl" value="TOTAL"
              checked={completude === "TOTAL"} onChange={() => { setCompletude("TOTAL"); setConfirmouTotal(false); }} />
            {" "}<strong>TOTAL</strong> — extracao completa do portador 195
          </label>
          <label style={{ ...S.rot, marginLeft: 16 }}>
            <input type="radio" name="compl" value="PARCIAL"
              checked={completude === "PARCIAL"} onChange={() => { setCompletude("PARCIAL"); setConfirmouTotal(false); }} />
            {" "}<strong>PARCIAL</strong> — qualquer recorte
          </label>

          {completude === "TOTAL" && (
            <div style={{ ...S.card, marginTop: 12, borderColor: "var(--rv-ambar-texto)" }}>
              <strong>Confirme o que TOTAL significa</strong>
              <p style={S.obs}>
                Este arquivo contem <strong>todos os titulos do portador 195</strong>,
                sem nenhum filtro adicional de bordero, tipo de boleto, situacao,
                aluno, unidade, vencimento ou qualquer outro recorte.
              </p>
              <label style={S.rot}>
                <input type="checkbox" checked={confirmouTotal}
                  onChange={(ev) => setConfirmouTotal(ev.target.checked)} />
                {" "}Confirmo que extrai sem filtro adicional.
              </label>
              <p style={S.obs}>
                Se nao puder afirmar isso, volte e marque <strong>PARCIAL</strong>.
                Um PARCIAL nunca e usado para comparar ausencia — declarar errado
                como TOTAL e que estraga a serie.
              </p>
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <label style={S.rot}>Instante da extracao na ULBRA{" "}
              <input type="datetime-local" value={snapshotAt}
                onChange={(ev) => setSnapshotAt(ev.target.value)} />
            </label>
            <div style={S.obs}>Em branco = agora. Informe quando o arquivo for de antes.</div>
          </div>
        </div>
      )}

      {erro && <div style={S.erro}>{erro}</div>}

      {resumo && !resultado && (
        <div style={S.card}>
          <h2 style={S.h2}>Previa (nada gravado ainda)</h2>
          <div style={S.grid}>
            <div style={S.box}><div style={S.num}>{resumo.parcelas.toLocaleString("pt-BR")}</div><div style={S.rot}>Parcelas de acordo</div></div>
            <div style={S.box}><div style={S.num}>{resumo.acordos.toLocaleString("pt-BR")}</div><div style={S.rot}>Acordos</div></div>
            <div style={S.box}><div style={S.num}>{resumo.cpfs.toLocaleString("pt-BR")}</div><div style={S.rot}>CPFs (alunos)</div></div>
            <div style={S.box}><div style={S.num}>{moeda(resumo.total)}</div><div style={S.rot}>Total em aberto</div></div>
          </div>
          <button style={S.btn} onClick={importar}
            disabled={importando || !completude || (completude === "TOTAL" && !confirmouTotal)}>
            {importando ? (progresso || "Importando...") : "Confirmar e importar"}
          </button>
          <div style={S.obs}>Titulos ja existentes (mesmo documento) sao ignorados automaticamente. A importacao e etiquetada para ser reversivel.</div>
        </div>
      )}

      {resultado && (
        <div style={S.cardOk}>
          <h2 style={S.h2}>Importacao concluida ✅</h2>
          <ul style={S.lista}>
            <li><strong>{resultado.titulos_inseridos.toLocaleString("pt-BR")}</strong> titulos inseridos</li>
            <li><strong>{resultado.alunos_novos.toLocaleString("pt-BR")}</strong> alunos novos criados</li>
            <li><strong>{resultado.acordos_na_fila.toLocaleString("pt-BR")}</strong> acordos na fila de confirmacao</li>
          </ul>
          {resultado.duplicados > 0 && (
            <div style={S.avisoDup}>
              ⚠️ <strong>{resultado.duplicados.toLocaleString("pt-BR")} acordo{resultado.duplicados > 1 ? "s" : ""} entrou duplicado</strong> —
              o aluno já tinha um acordo ATIVO com o mesmo valor e a mesma quantidade de parcelas.
              Nada foi barrado: eles estão na base, marcados para conferência. Abra
              <strong> Acordos duplicados</strong> em Ferramentas para ver o novo e o antigo lado a lado
              e decidir qual cancelar.
            </div>
          )}
          {resultado.pulados > 0 && (
            <div style={S.avisoPulado}>
              🛡️ <strong>{resultado.pulados.toLocaleString("pt-BR")} aluno{resultado.pulados > 1 ? "s" : ""} não {resultado.pulados > 1 ? "foram" : "foi"} importado{resultado.pulados > 1 ? "s" : ""}</strong>{" "}
              ({resultado.linhasPuladas.toLocaleString("pt-BR")} linhas do arquivo) — {resultado.pulados > 1 ? "eles já foram" : "ele já foi"} quitado{resultado.pulados > 1 ? "s" : ""} aqui
              nos últimos 7 dias e {resultado.pulados > 1 ? "têm" : "tem"} acordo. O relatório da Prime ainda mostra a dívida
              porque ela não refletiu a baixa. Importar traria a dívida de volta.
            </div>
          )}
          <div style={S.obs}>Lote: {resultado.importacaoId}</div>
        </div>
      )}

      <div style={S.card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 style={S.h2}>Histórico de importações</h2>
          <button style={S.btnGhost} onClick={carregarHistorico}>Atualizar</button>
        </div>
        {historico == null && <div style={S.obs}>Carregando…</div>}
        {historico && historico.length === 0 && <div style={S.obs}>Nenhuma importação registrada ainda.</div>}
        {historico && historico.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={S.tab}>
              <thead>
                <tr>
                  <th style={S.th}>Quando</th>
                  <th style={S.th}>Arquivo</th>
                  <th style={S.th}>Quem</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Acordos</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Títulos</th>
                  <th style={{ ...S.th, textAlign: "right" }}>CPFs</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {historico.map((h, idx) => (
                  <tr key={h.importacao_id} style={idx === 0 ? S.trNovo : undefined}>
                    <td style={S.td}>{dataHora(h.importado_em)}{idx === 0 && <span style={S.tagUlt}>última</span>}</td>
                    <td style={S.td}>{h.arquivo_nome || <span style={{ color: "var(--rv-texto-fraco)" }}>— (import antigo)</span>}</td>
                    <td style={S.td}>{h.importado_por || "—"}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>{h.acordos != null ? Number(h.acordos).toLocaleString("pt-BR") : "—"}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>{h.titulos_inseridos != null ? Number(h.titulos_inseridos).toLocaleString("pt-BR") : "—"}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>{h.cpfs != null ? Number(h.cpfs).toLocaleString("pt-BR") : "—"}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>{h.total != null ? moeda(h.total) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const S = {
  wrap: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", color: "var(--rv-tinta)", background: "var(--rv-fundo)", minHeight: "100%" },
  titulo: { margin: 0, fontFamily: "'Sora', Inter, sans-serif", fontSize: 26, fontWeight: 800, color: "var(--rv-tinta)", letterSpacing: "-0.03em" },
  sub: { margin: "6px 0 18px", color: "var(--rv-texto-suave)", fontSize: 13.5, maxWidth: 720 },
  card: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda)", borderRadius: 16, padding: 18, marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 },
  cardOk: { background: "var(--rv-verde-ok-fundo)", border: "1px solid var(--rv-verde-ok-borda)", borderRadius: 16, padding: 18, marginBottom: 16 },
  arq: { fontSize: 12.5, color: "var(--rv-texto-suave)" },
  h2: { margin: "0 0 6px", fontFamily: "'Sora', Inter, sans-serif", fontSize: 16, fontWeight: 800, color: "var(--rv-tinta)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 },
  box: { background: "var(--rv-fundo-cartao)", border: "1px solid var(--rv-borda)", borderRadius: 12, padding: "12px 14px", textAlign: "center" },
  num: { fontSize: 22, fontWeight: 800, color: "var(--rv-tinta)", fontFamily: "'Sora', Inter, sans-serif" },
  rot: { fontSize: 12, color: "var(--rv-texto-fraco)", fontWeight: 600, marginTop: 3 },
  btn: { alignSelf: "flex-start", background: "#1e40af", color: "#fff", border: "none", borderRadius: 10, padding: "12px 22px", fontWeight: 800, fontSize: 14, cursor: "pointer" },
  obs: { fontSize: 12, color: "var(--rv-texto-fraco)" },
  // I2 - escopo declarado
  boxEscopo: { background: "var(--rv-fundo-cartao)", border: "1px dashed var(--rv-borda)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 },
  linhaEscopo: { display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-end" },
  lblE: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 700, color: "var(--rv-texto-suave)" },
  inpE: { border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "7px 9px", fontSize: 13, background: "var(--rv-superficie)", color: "var(--rv-tinta)", minWidth: 150 },
  avisoPulado: {
    background: "var(--rv-verde-ok-fundo)", border: "1px solid var(--rv-verde-ok-borda)", color: "var(--rv-verde-ok-texto)",
    borderRadius: 10, padding: "12px 14px", fontSize: 13, lineHeight: 1.55, margin: "10px 0",
  },
  avisoDup: {
    background: "var(--rv-ambar-fundo)", border: "1px solid var(--rv-ambar-borda)", color: "var(--rv-ambar-texto)",
    borderRadius: 10, padding: "12px 14px", fontSize: 13, lineHeight: 1.55, margin: "10px 0",
  },
  erro: { background: "var(--rv-vermelho-fundo)", border: "1px solid var(--rv-vermelho-borda)", color: "var(--rv-vermelho-texto)", borderRadius: 12, padding: "12px 16px", marginBottom: 16, fontSize: 13.5, fontWeight: 600 },
  lista: { margin: "6px 0 8px", paddingLeft: 18, fontSize: 14, color: "var(--rv-verde-ok-texto)", lineHeight: 1.7 },
  btnGhost: { background: "var(--rv-superficie)", color: "var(--rv-azul-texto)", border: "1px solid var(--rv-roxo-borda)", borderRadius: 9, padding: "7px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  tab: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", color: "var(--rv-texto-suave)", fontWeight: 700, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.03em", padding: "8px 10px", borderBottom: "1px solid var(--rv-borda)", whiteSpace: "nowrap" },
  td: { padding: "9px 10px", borderBottom: "1px solid var(--rv-borda-suave)", color: "var(--rv-tinta)", whiteSpace: "nowrap" },
  trNovo: { background: "var(--rv-azul-fundo)" },
  tagUlt: { marginLeft: 8, background: "#1e40af", color: "#fff", borderRadius: 6, padding: "1px 7px", fontSize: 10.5, fontWeight: 800, verticalAlign: "middle" },
};
