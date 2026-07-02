import { useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";
import { emailPorNomeOperador, nomeOperadorPorEmail } from "../utils/operadores";

function normalizarNome(nome) {
  return String(nome || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ");
}

function paraDataISO(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor.toISOString();
  return null;
}

const TAMANHO_LOTE = 500;

export default function VincularBaseOperacional() {
  const [processando, setProcessando] = useState(false);
  const [preview, setPreview] = useState(null);
  const [importando, setImportando] = useState(false);
  const [progresso, setProgresso] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState("");

  async function selecionarArquivo(e) {
    const arquivo = e.target.files?.[0];
    if (!arquivo) return;

    setResultado(null);
    setErro("");
    setProcessando(true);

    try {
      const buffer = await arquivo.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const primeiraAba = workbook.SheetNames[0];
      const linhasBrutas = XLSX.utils.sheet_to_json(workbook.Sheets[primeiraAba], {
        raw: true,
        defval: null,
      });

      if (linhasBrutas.length === 0) {
        setErro("Não encontrei linhas nessa planilha.");
        setProcessando(false);
        return;
      }

      // Colunas identificadas pela posição, já que o cabeçalho original
      // vem com algumas células erradas/mescladas na planilha de origem:
      // 3 = Aluno, 7 = Data do último acionamento, 8 = Status Acionamento,
      // 13 = Operador Mensalidade.
      const cabecalho = Object.keys(linhasBrutas[0]);
      const colNome = cabecalho[3];
      const colDataAcionamento = cabecalho[7];
      const colStatusAcionamento = cabecalho[8];
      const colOperadorMensalidade = cabecalho[13];

      const linhas = linhasBrutas
        .map((linha) => ({
          nomeOriginal: linha[colNome],
          nomeNormalizado: normalizarNome(linha[colNome]),
          dataAcionamento: paraDataISO(linha[colDataAcionamento]),
          statusAcionamento: linha[colStatusAcionamento]
            ? String(linha[colStatusAcionamento]).trim()
            : null,
          operadorArquivo: linha[colOperadorMensalidade]
            ? String(linha[colOperadorMensalidade]).trim()
            : null,
        }))
        .filter((linha) => linha.nomeNormalizado);

      // Busca todos os alunos de uma vez (nome + cpf) pra casar em memória,
      // em vez de uma consulta por linha.
      const { data: todosAlunos } = await supabase.from("alunos").select("id, nome, cpf");

      const mapaAlunosPorNome = new Map();
      for (const aluno of todosAlunos || []) {
        const chave = normalizarNome(aluno.nome);
        if (!mapaAlunosPorNome.has(chave)) {
          mapaAlunosPorNome.set(chave, []);
        }
        mapaAlunosPorNome.get(chave).push(aluno);
      }

      const linhasComStatus = linhas.map((linha) => {
        const candidatos = mapaAlunosPorNome.get(linha.nomeNormalizado) || [];
        const ambiguo = candidatos.length > 1;
        const aluno = candidatos.length === 1 ? candidatos[0] : null;

        const emailOperador = linha.operadorArquivo
          ? emailPorNomeOperador(linha.operadorArquivo)
          : null;

        const temAlgumDado = Boolean(
          emailOperador || linha.statusAcionamento || linha.dataAcionamento
        );

        return {
          ...linha,
          aluno,
          ambiguo,
          emailOperador,
          operadorNaoReconhecido: Boolean(linha.operadorArquivo) && !emailOperador,
          temAlgumDado,
        };
      });

      const encontrados = linhasComStatus.filter((l) => l.aluno).length;
      const naoEncontrados = linhasComStatus.filter((l) => !l.aluno && !l.ambiguo).length;
      const ambiguos = linhasComStatus.filter((l) => l.ambiguo).length;
      const comAtualizacao = linhasComStatus.filter((l) => l.aluno && l.temAlgumDado).length;
      const operadoresNaoReconhecidos = [
        ...new Set(
          linhasComStatus.filter((l) => l.operadorNaoReconhecido).map((l) => l.operadorArquivo)
        ),
      ];

      setPreview({
        linhas: linhasComStatus,
        totais: {
          total: linhasComStatus.length,
          encontrados,
          naoEncontrados,
          ambiguos,
          comAtualizacao,
        },
        operadoresNaoReconhecidos,
      });
    } catch (err) {
      console.error(err);
      setErro("Não consegui ler essa planilha. Confira o arquivo.");
    } finally {
      setProcessando(false);
    }
  }

  async function confirmarVinculo() {
    if (!preview) return;

    setImportando(true);
    setErro("");

    try {
      const registros = preview.linhas
        .filter((l) => l.aluno && l.temAlgumDado)
        .map((l) => {
          const registro = { id: l.aluno.id };

          if (l.emailOperador) {
            registro.responsavel_atual_email = l.emailOperador;
            registro.responsavel_atual_nome = nomeOperadorPorEmail(l.emailOperador);
            registro.responsavel_atual_em = new Date().toISOString();
          }

          if (l.statusAcionamento) {
            registro.status_acionamento = l.statusAcionamento;
          }

          if (l.dataAcionamento) {
            registro.data_ultimo_acionamento = l.dataAcionamento;
          }

          return registro;
        });

      let atualizados = 0;

      for (let i = 0; i < registros.length; i += TAMANHO_LOTE) {
        const lote = registros.slice(i, i + TAMANHO_LOTE);
        setProgresso({ feito: i, total: registros.length });

        const { error } = await supabase.from("alunos").upsert(lote, { onConflict: "id" });
        if (!error) atualizados += lote.length;
      }

      setProgresso(null);
      setResultado({ atualizados, total: registros.length });
      setPreview(null);
    } catch (err) {
      console.error(err);
      setErro("Erro ao vincular. Tente novamente.");
    } finally {
      setImportando(false);
    }
  }

  return (
    <div className="main">
      <h1>Vincular base operacional</h1>
      <p style={{ opacity: 0.75, marginBottom: 20 }}>
        Sobe a planilha da base operacional. Casa por nome do aluno, e carrega operador da
        mensalidade (vira responsável), status do acionamento e data do último acionamento.
        Nada é gravado até confirmar.
      </p>

      <div style={estilos.caixaUpload}>
        <input type="file" accept=".xls,.xlsx" onChange={selecionarArquivo} />
        {processando && <p style={{ marginTop: 10 }}>Lendo planilha...</p>}
      </div>

      {erro && <p style={{ color: "#f87171", marginTop: 12 }}>{erro}</p>}

      {resultado && (
        <div style={estilos.caixaSucesso}>
          <strong>Vínculo concluído.</strong>
          <p style={{ margin: "6px 0 0" }}>
            {resultado.atualizados} de {resultado.total} alunos atualizados.
          </p>
        </div>
      )}

      {preview && (
        <div style={{ marginTop: 20 }}>
          <div style={estilos.grade}>
            <div style={estilos.cartao}>
              <div style={estilos.numero}>{preview.totais.total}</div>
              <div style={estilos.label}>Total no arquivo</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(34,197,94,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#86efac" }}>
                {preview.totais.encontrados}
              </div>
              <div style={estilos.label}>Encontrados pelo nome</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(251,191,36,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#fcd34d" }}>
                {preview.totais.naoEncontrados}
              </div>
              <div style={estilos.label}>Não encontrados</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(56,189,248,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#7dd3fc" }}>
                {preview.totais.ambiguos}
              </div>
              <div style={estilos.label}>Nome ambíguo (mais de 1 aluno)</div>
            </div>
            <div style={estilos.cartao}>
              <div style={estilos.numero}>{preview.totais.comAtualizacao}</div>
              <div style={estilos.label}>Vão ser atualizados</div>
            </div>
          </div>

          {preview.operadoresNaoReconhecidos.length > 0 && (
            <p style={{ fontSize: 13, color: "#fcd34d", marginTop: 12 }}>
              Valores na coluna de operador que não reconheci como operador real (não vão
              virar responsável, só ignorados nesse campo):{" "}
              {preview.operadoresNaoReconhecidos.join(", ")}
            </p>
          )}

          <button
            type="button"
            onClick={confirmarVinculo}
            disabled={importando}
            style={estilos.botaoConfirmar}
          >
            {importando
              ? progresso
                ? `Vinculando... ${progresso.feito}/${progresso.total}`
                : "Vinculando..."
              : "Confirmar vínculo"}
          </button>
        </div>
      )}
    </div>
  );
}

const estilos = {
  caixaUpload: {
    padding: 20,
    borderRadius: 10,
    border: "1px dashed rgba(148,163,184,0.4)",
    background: "rgba(148,163,184,0.05)",
  },
  caixaSucesso: {
    marginTop: 16,
    padding: "12px 16px",
    borderRadius: 10,
    background: "rgba(34,197,94,0.1)",
    border: "1px solid rgba(34,197,94,0.3)",
  },
  grade: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 12,
  },
  cartao: {
    padding: 16,
    borderRadius: 10,
    background: "rgba(148,163,184,0.08)",
  },
  numero: {
    fontSize: 22,
    fontWeight: 800,
  },
  label: {
    fontSize: 12,
    opacity: 0.75,
    marginTop: 4,
  },
  botaoConfirmar: {
    marginTop: 16,
    padding: "10px 20px",
    borderRadius: 8,
    border: "1px solid rgba(34,197,94,0.6)",
    background: "rgba(34,197,94,0.16)",
    color: "#86efac",
    fontWeight: 600,
    cursor: "pointer",
  },
};
