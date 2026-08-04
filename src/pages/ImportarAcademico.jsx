import { useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";

// Importar Dados Academicos (Relatorio de Inadimplencia do sistema academico).
//
// REGRA: este fluxo SO ENRIQUECE aluno que ja existe (curso real + situacao
// academica). Chama a RPC importar_dados_academicos, que faz APENAS UPDATE,
// nunca INSERT: nao cria aluno, nao cria titulo, nao toca em saldo/acordo/
// financeiro/modalidade. Idempotente: reimportar da o mesmo resultado.
// Vinculo por: 1) CPF (se o relatorio trouxer) 2) e-mail 3) nome+estabelecimento.

function norm(s) {
  return String(s == null ? "" : s)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

// Parser de CSV robusto (separador ; ou ,) com aspas e "" escapado.
function parseCSV(texto) {
  const sep = (texto.split("\n")[0].match(/;/g) || []).length >=
              (texto.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  const linhas = [];
  let campo = "", linha = [], dentroAspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentroAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else dentroAspas = false;
      } else campo += c;
    } else {
      if (c === '"') dentroAspas = true;
      else if (c === sep) { linha.push(campo); campo = ""; }
      else if (c === "\n") { linha.push(campo); linhas.push(linha); linha = []; campo = ""; }
      else if (c === "\r") { /* ignora */ }
      else campo += c;
    }
  }
  if (campo.length || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter((l) => l.some((x) => String(x).trim() !== ""));
}

// Descobre em qual coluna esta cada campo, por nome de cabecalho normalizado.
function mapearColunas(cabecalho) {
  const H = cabecalho.map((c) => norm(c));
  const achar = (fn) => { const i = H.findIndex(fn); return i; };
  return {
    codigo: achar((h) => h === "codigo" || h.startsWith("codigo") || h === "matricula"),
    nome: achar((h) => h.includes("nome")),
    curso: achar((h) => h === "curso"),
    email: achar((h) => h.includes("mail")),
    estab: achar((h) => h.includes("estabelec")),
    situacao: achar((h) => h.includes("situacao") || h.includes("situacaoacademica")),
    cpf: achar((h) => h.includes("cpf") || h.includes("documento")),
  };
}

function baixarCSV(nome, linhas) {
  const csv = linhas.map((l) => l.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nome; a.click();
  URL.revokeObjectURL(url);
}

export default function ImportarAcademico() {
  const [linhas, setLinhas] = useState(null);
  const [resumo, setResumo] = useState(null);
  const [erro, setErro] = useState("");
  const [importando, setImportando] = useState(false);
  const [progresso, setProgresso] = useState("");
  const [resultado, setResultado] = useState(null);
  const [nomeArquivo, setNomeArquivo] = useState("");
  const [temCpf, setTemCpf] = useState(false);

  function processarLinhas(matriz) {
    if (!matriz || matriz.length < 2) { setErro("Arquivo vazio ou sem dados."); return; }
    const cols = mapearColunas(matriz[0]);
    if (cols.nome < 0 || cols.curso < 0) {
      setErro("Nao encontrei as colunas de Nome e Curso. Confira se e o Relatorio de Inadimplencia.");
      return;
    }
    const out = [], vistos = new Set();
    for (let i = 1; i < matriz.length; i++) {
      const r = matriz[i];
      const codigo = cols.codigo >= 0 ? String(r[cols.codigo] || "").trim() : "";
      const nome = String(r[cols.nome] || "").trim();
      if (!nome) continue;
      if (/total/i.test(codigo)) continue;            // linha de rodape "Total: N Alunos"
      const chave = codigo || norm(nome) + "|" + norm(r[cols.email] || "");
      if (vistos.has(chave)) continue;                // dedup por codigo (ou nome+email)
      vistos.add(chave);
      out.push({
        codigo,
        nome,
        curso: String(r[cols.curso] || "").trim(),
        email: cols.email >= 0 ? String(r[cols.email] || "").trim() : "",
        estabelecimento: cols.estab >= 0 ? String(r[cols.estab] || "").trim() : "",
        situacao: cols.situacao >= 0 ? String(r[cols.situacao] || "").trim() : "",
        cpf: cols.cpf >= 0 ? String(r[cols.cpf] || "").replace(/\D/g, "") : "",
      });
    }
    if (out.length === 0) { setErro("Nenhuma linha valida encontrada."); return; }
    const comCpf = out.filter((o) => o.cpf.length >= 11).length;
    setTemCpf(comCpf > 0);
    setLinhas(out);
    setResumo({
      linhas: out.length,
      comCurso: out.filter((o) => o.curso).length,
      comSituacao: out.filter((o) => o.situacao).length,
      comCpf,
    });
  }

  function analisar(e) {
    setErro(""); setResultado(null); setResumo(null); setLinhas(null);
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setNomeArquivo(file.name);
    const ehCsv = /\.csv$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        if (ehCsv) {
          const buf = new Uint8Array(ev.target.result);
          let texto = new TextDecoder("utf-8").decode(buf);
          if (texto.includes("�")) texto = new TextDecoder("iso-8859-1").decode(buf); // acentos latin-1
          processarLinhas(parseCSV(texto));
        } else {
          const wb = XLSX.read(new Uint8Array(ev.target.result), { type: "array" });
          const sh = wb.Sheets[wb.SheetNames[0]];
          const matriz = XLSX.utils.sheet_to_json(sh, { header: 1, defval: "" });
          processarLinhas(matriz);
        }
      } catch (err) {
        setErro("Erro ao ler o arquivo: " + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function importar() {
    if (!linhas) return;
    setImportando(true); setErro(""); setResultado(null);
    const BATCH = 500;
    const acc = { total: 0, casados: 0, curso_atualizado: 0, situacao_atualizada: 0, pendentes: [] };
    try {
      for (let i = 0; i < linhas.length; i += BATCH) {
        const chunk = linhas.slice(i, i + BATCH);
        setProgresso("Processando " + Math.min(i + BATCH, linhas.length) + " de " + linhas.length + "...");
        const { data, error } = await supabase.rpc("importar_dados_academicos", {
          p_linhas: chunk, p_fonte: "relatorio_inadimplencia", p_arquivo: nomeArquivo,
        });
        if (error) throw error;
        acc.total += data?.total || 0;
        acc.casados += data?.casados || 0;
        acc.curso_atualizado += data?.curso_atualizado || 0;
        acc.situacao_atualizada += data?.situacao_atualizada || 0;
        if (Array.isArray(data?.pendentes)) acc.pendentes.push(...data.pendentes);
      }
      setResultado(acc);
      setProgresso("");
    } catch (err) {
      setErro("Erro na importacao: " + (err.message || err));
    } finally {
      setImportando(false);
    }
  }

  function baixarPendentes() {
    const cab = ["codigo", "nome", "email", "estabelecimento", "curso", "situacao", "motivo"];
    const rows = [cab, ...resultado.pendentes.map((p) => cab.map((k) => p[k] ?? ""))];
    baixarCSV("pendencias_academico.csv", rows);
  }

  return (
    <div style={S.wrap}>
      <h1 style={S.titulo}>Importar Dados Acadêmicos</h1>
      <p style={S.sub}>
        Suba o <strong>Relatório de Inadimplência</strong> do sistema acadêmico. Ele preenche
        o <strong>curso real</strong> e a <strong>situação acadêmica</strong> na ficha do aluno.
        Este fluxo <strong>só atualiza aluno que já existe</strong> — não cria aluno, não cria título
        e não toca em saldo, acordo, mensalidade ou modalidade. Reimportar não duplica nada.
      </p>

      <div style={S.card}>
        <input type="file" accept=".csv,.xls,.xlsx" onChange={analisar} style={{ fontSize: 14 }} />
        {nomeArquivo && <span style={S.arq}>{nomeArquivo}</span>}
      </div>

      {erro && <div style={S.erro}>{erro}</div>}

      {resumo && !resultado && (
        <div style={S.card}>
          <h2 style={S.h2}>Prévia (nada gravado ainda)</h2>
          <div style={S.grid}>
            <div style={S.box}><div style={S.num}>{resumo.linhas.toLocaleString("pt-BR")}</div><div style={S.rot}>Alunos no arquivo</div></div>
            <div style={S.box}><div style={S.num}>{resumo.comCurso.toLocaleString("pt-BR")}</div><div style={S.rot}>Com curso</div></div>
            <div style={S.box}><div style={S.num}>{resumo.comSituacao.toLocaleString("pt-BR")}</div><div style={S.rot}>Com situação</div></div>
            <div style={S.box}><div style={S.num}>{resumo.comCpf.toLocaleString("pt-BR")}</div><div style={S.rot}>Com CPF</div></div>
          </div>
          <div style={S.obs}>
            Vínculo por {temCpf ? "CPF → e-mail → nome+estabelecimento" : "e-mail → nome+estabelecimento"}.
            O que não casar vai para uma lista de pendências (não grava no aluno errado).
          </div>
          <button style={S.btn} disabled={importando} onClick={importar}>
            {importando ? (progresso || "Importando...") : "Confirmar e importar"}
          </button>
        </div>
      )}

      {resultado && (
        <div style={S.cardOk}>
          <h2 style={S.h2}>Importação concluída ✅</h2>
          <ul style={S.lista}>
            <li><strong>{resultado.casados.toLocaleString("pt-BR")}</strong> alunos atualizados (de {resultado.total.toLocaleString("pt-BR")})</li>
            <li><strong>{resultado.curso_atualizado.toLocaleString("pt-BR")}</strong> com curso real gravado</li>
            <li><strong>{resultado.situacao_atualizada.toLocaleString("pt-BR")}</strong> com situação acadêmica gravada</li>
            <li><strong>{resultado.pendentes.length.toLocaleString("pt-BR")}</strong> pendências (não casaram)</li>
          </ul>
          {resultado.pendentes.length > 0 && (
            <button style={S.btnSec} onClick={baixarPendentes}>Baixar pendências (CSV)</button>
          )}
          <div style={S.obs}>Nenhum título, saldo, acordo ou modalidade foi alterado. Pode reimportar sem duplicar.</div>
        </div>
      )}
    </div>
  );
}

const S = {
  wrap: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", color: "#0f172a", background: "#f4f6fa", minHeight: "100%" },
  titulo: { margin: 0, fontFamily: "'Sora', Inter, sans-serif", fontSize: 26, fontWeight: 800, color: "#0d1321", letterSpacing: "-0.03em" },
  sub: { margin: "6px 0 18px", color: "#64748b", fontSize: 13.5, maxWidth: 760, lineHeight: 1.6 },
  card: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 16, padding: 18, marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 },
  cardOk: { background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 16, padding: 18, marginBottom: 16, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" },
  arq: { fontSize: 12.5, color: "#64748b" },
  h2: { margin: "0 0 6px", fontFamily: "'Sora', Inter, sans-serif", fontSize: 16, fontWeight: 800, color: "#0d1321" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 },
  box: { background: "#f8fafc", border: "1px solid #e6eaf0", borderRadius: 12, padding: "12px 14px", textAlign: "center" },
  num: { fontSize: 22, fontWeight: 800, color: "#0d1321", fontFamily: "'Sora', Inter, sans-serif" },
  rot: { fontSize: 12, color: "#8a93a3", fontWeight: 600, marginTop: 3 },
  btn: { alignSelf: "flex-start", background: "#1e40af", color: "#fff", border: "none", borderRadius: 10, padding: "12px 22px", fontWeight: 800, fontSize: 14, cursor: "pointer" },
  btnSec: { background: "#fff", color: "#166534", border: "1px solid #86efac", borderRadius: 10, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  obs: { fontSize: 12, color: "#8a93a3" },
  erro: { background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 12, padding: "12px 16px", marginBottom: 16, fontSize: 13.5, fontWeight: 600 },
  lista: { margin: "6px 0 8px", paddingLeft: 18, fontSize: 14, color: "#166534", lineHeight: 1.7 },
};
