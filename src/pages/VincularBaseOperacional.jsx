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

// Casos marcados na planilha como cancelamento de cobrança ou jurídico
// precisam sair da cobrança ativa -- a ficha do aluno já bloqueia
// acionamento pra quem não é Amanda/Fernanda/Amanda ADM quando o status
// é um desses dois (ver STATUS_BLOQUEADOS_ACIONAMENTO em FilaOperacional).
// Aqui só detecta a partir do texto bruto da coluna de operador.
function detectarBloqueioCobranca(textoOperadorBruto) {
  const normalizado = normalizarNome(textoOperadorBruto);
  if (!normalizado) return null;
  if (normalizado.includes("CANCELAMENTO")) return "CANCELAMENTO_COBRANCA";
  if (normalizado.includes("JURIDIC")) return "JURIDICO";
  return null;
}

// Caso "quitado" na planilha: sai da fila do operador (reassina o
// responsável pra Amanda gestora revisar) em vez de continuar aparecendo
// pra quem estava cobrando.
function detectarQuitado(textoOperadorBruto) {
  const normalizado = normalizarNome(textoOperadorBruto);
  if (!normalizado) return false;
  return normalizado.includes("QUITAD") || normalizado.includes("QUITACAO");
}

const EMAIL_AMANDA_GESTORA = "amanda.seibel@aelbra.com.br";

// Datas podem vir como objeto Date (quando o Excel já formata a célula como
// data) ou como número serial do Excel (quando a célula é texto/genérico).
// Trata os dois casos pra não perder a data.
function paraDataISO(valor) {
  if (!valor && valor !== 0) return null;
  if (valor instanceof Date) return valor.toISOString();
  if (typeof valor === "number") {
    const data = XLSX.SSF.parse_date_code(valor);
    if (!data) return null;
    return new Date(Date.UTC(data.y, data.m - 1, data.d)).toISOString();
  }
  if (typeof valor === "string") {
    const partes = valor.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (partes) {
      const [, dia, mes, ano] = partes;
      const anoCompleto = ano.length === 2 ? Number(ano) + 2000 : Number(ano);
      return new Date(Date.UTC(anoCompleto, Number(mes) - 1, Number(dia))).toISOString();
    }
  }
  return null;
}

// Busca TODOS os alunos, paginando (o Supabase limita a 1000 linhas por
// request por padrão) — essencial pra base ter ~16 mil alunos.
async function buscarTodosAlunos() {
  const TAMANHO_PAGINA = 1000;
  let todos = [];
  let pagina = 0;
  while (true) {
    const { data, error } = await supabase
      .from("alunos")
      .select(
        "id, nome, cpf, responsavel_atual_email, responsavel_atual_nome, responsavel_atual_em, status_acionamento, data_ultimo_acionamento, nivel_criticidade, status_jornada, status_atual, observacao"
      )
      .range(pagina * TAMANHO_PAGINA, pagina * TAMANHO_PAGINA + TAMANHO_PAGINA - 1);
    if (error) throw error;
    todos = todos.concat(data || []);
    if (!data || data.length < TAMANHO_PAGINA) break;
    pagina += 1;
  }
  return todos;
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
      const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
      // A planilha "Reativa_base" completa tem várias abas (Controle de
      // Pagamentos, Dashboard, Regras etc.). A que interessa aqui é
      // "Operação Sintética" -- procura por nome (aceitando variações de
      // acento/maiúscula) e só usa a primeira aba como último recurso, se
      // não achar nenhuma parecida.
      const nomeAbaAlvo = "operacao sintetica";
      const normalizarNomeAba = (s) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .toLowerCase()
          .trim();
      const abaEncontrada = workbook.SheetNames.find(
        (nome) => normalizarNomeAba(nome) === nomeAbaAlvo
      );
      const primeiraAba = abaEncontrada || workbook.SheetNames[0];
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
      // 3 = Aluno, 4 = Operador responsável (quem está de fato acionando o
      // caso hoje -- pode vir com o nome do operador ou com "RECEPTIVO"
      // quando ainda não tem dono; sem cabeçalho de texto na planilha),
      // 7 = Data do último acionamento, 8 = Status Acionamento,
      // 9 = Criticidade (emoji, sem cabeçalho de texto), 13 = Operador
      // Mensalidade (campo mais antigo, usado como reserva quando a
      // coluna 4 vem em branco).
      const cabecalho = Object.keys(linhasBrutas[0]);
      const colNome = cabecalho[3];
      const colOperadorResponsavel = cabecalho[4];
      const colDataAcionamento = cabecalho[7];
      const colStatusAcionamento = cabecalho[8];
      const colCriticidade = cabecalho[9];
      const colOperadorMensalidade = cabecalho[13];

      const linhas = linhasBrutas
        .map((linha) => {
          const operadorBruto =
            (linha[colOperadorResponsavel] && String(linha[colOperadorResponsavel]).trim()) ||
            (linha[colOperadorMensalidade] && String(linha[colOperadorMensalidade]).trim()) ||
            null;

          return {
          nomeOriginal: linha[colNome],
          nomeNormalizado: normalizarNome(linha[colNome]),
          dataAcionamento: paraDataISO(linha[colDataAcionamento]),
          statusAcionamento: linha[colStatusAcionamento]
            ? String(linha[colStatusAcionamento]).trim()
            : null,
          criticidade: linha[colCriticidade]
            ? String(linha[colCriticidade]).trim()
            : null,
          operadorArquivo: operadorBruto,
          bloqueioCobranca: detectarBloqueioCobranca(operadorBruto),
          quitado: detectarQuitado(operadorBruto),
          };
        })
        .filter((linha) => linha.nomeNormalizado);

      // Busca todos os alunos (paginado) pra casar em memória, em vez de
      // uma consulta por linha.
      const todosAlunos = await buscarTodosAlunos();

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

        // Quando o nome bate em mais de um aluno, tenta desempatar: se só
        // um dos candidatos já tem responsável (operador) cadastrado, é
        // bem provável que seja o cadastro "de verdade" (o outro costuma
        // ser um registro duplicado sem dono). Só resolve sozinho quando
        // dá pra ter certeza (exatamente 1 com responsável); se mais de um
        // já tiver responsável, ou nenhum tiver, continua ambíguo.
        let aluno = null;
        let ambiguo = false;

        if (candidatos.length === 1) {
          aluno = candidatos[0];
        } else if (candidatos.length > 1) {
          const comResponsavel = candidatos.filter((c) => c.responsavel_atual_email);

          if (comResponsavel.length === 1) {
            aluno = comResponsavel[0];
          } else {
            ambiguo = true;
          }
        }

        const emailOperador = linha.operadorArquivo
          ? emailPorNomeOperador(linha.operadorArquivo)
          : null;

        // Só preenche o que estiver em branco no cadastro. Nunca sobrescreve
        // responsável/status/data que já existem — isso evita desfazer
        // trabalho que os operadores já fizeram no CRM depois da planilha.
        const vaiPreencherResponsavel = Boolean(
          emailOperador && aluno && !aluno.responsavel_atual_email
        );
        const vaiPreencherStatus = Boolean(
          linha.statusAcionamento && aluno && !aluno.status_acionamento
        );
        const vaiPreencherData = Boolean(
          linha.dataAcionamento && aluno && !aluno.data_ultimo_acionamento
        );
        const vaiPreencherCriticidade = Boolean(
          linha.criticidade && aluno && !aluno.nivel_criticidade
        );

        // Cancelamento de cobrança e jurídico sempre valem, mesmo que o
        // aluno já tenha outro status -- é uma sinalização de segurança
        // (não cobrar), não um preenchimento de campo em branco comum.
        const vaiBloquearCobranca = Boolean(linha.bloqueioCobranca && aluno);

        // Quitado sai da fila de quem estava cobrando e vai pra fila da
        // Amanda gestora revisar -- também sobrescreve o responsável atual.
        const vaiQuitar = Boolean(linha.quitado && aluno);

        const temAlgumDado =
          vaiPreencherResponsavel ||
          vaiPreencherStatus ||
          vaiPreencherData ||
          vaiPreencherCriticidade ||
          vaiBloquearCobranca ||
          vaiQuitar;

        return {
          ...linha,
          aluno,
          ambiguo,
          emailOperador,
          operadorNaoReconhecido:
            Boolean(linha.operadorArquivo) &&
            !emailOperador &&
            !linha.bloqueioCobranca &&
            !linha.quitado,
          vaiPreencherResponsavel,
          vaiPreencherStatus,
          vaiPreencherData,
          vaiPreencherCriticidade,
          vaiBloquearCobranca,
          vaiQuitar,
          temAlgumDado,
        };
      });

      const encontrados = linhasComStatus.filter((l) => l.aluno).length;
      const naoEncontrados = linhasComStatus.filter((l) => !l.aluno && !l.ambiguo).length;
      const ambiguos = linhasComStatus.filter((l) => l.ambiguo).length;
      const comAtualizacao = linhasComStatus.filter((l) => l.aluno && l.temAlgumDado).length;
      const bloqueiosCobranca = linhasComStatus.filter((l) => l.vaiBloquearCobranca).length;
      const quitados = linhasComStatus.filter((l) => l.vaiQuitar).length;
      const operadoresNaoReconhecidos = [
        ...new Set(
          linhasComStatus.filter((l) => l.operadorNaoReconhecido).map((l) => l.operadorArquivo)
        ),
      ];

      // Quantos alunos (encontrados no CRM) cada operador tem na planilha,
      // pra dar pra revisar inconsistência antes de confirmar o vínculo.
      const contagemPorOperadorMapa = new Map();
      for (const l of linhasComStatus) {
        if (!l.aluno || !l.emailOperador) continue;
        const nomeOp = nomeOperadorPorEmail(l.emailOperador);
        contagemPorOperadorMapa.set(nomeOp, (contagemPorOperadorMapa.get(nomeOp) || 0) + 1);
      }
      const contagemPorOperador = [...contagemPorOperadorMapa.entries()]
        .map(([nome, qtd]) => ({ nome, qtd }))
        .sort((a, b) => b.qtd - a.qtd);

      setPreview({
        linhas: linhasComStatus,
        abaUsada: primeiraAba,
        totais: {
          total: linhasComStatus.length,
          encontrados,
          naoEncontrados,
          ambiguos,
          comAtualizacao,
          bloqueiosCobranca,
          quitados,
        },
        operadoresNaoReconhecidos,
        contagemPorOperador,
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
      // Só entram no upsert linhas com pelo menos um campo em branco no
      // cadastro. Dentro de cada linha, só o(s) campo(s) que estavam vazios
      // recebem valor novo — o resto mantém exatamente o valor atual do
      // aluno. Importante: TODA linha do lote leva as MESMAS chaves (com o
      // valor novo ou o valor atual repetido), porque o upsert em lote do
      // Supabase grava um único INSERT com a união das colunas de todas as
      // linhas — se uma linha não tivesse uma chave que outra linha do
      // mesmo lote tem, essa coluna seria gravada como NULL nela (testado
      // e confirmado). Repetir o valor atual evita esse risco.
      const registrosBrutos = preview.linhas
        .filter((l) => l.aluno && l.temAlgumDado)
        .map((l) => ({
          id: l.aluno.id,
          // "nome" e obrigatorio na tabela (NOT NULL sem default). O
          // Postgres valida essa constraint no upsert mesmo quando a acao
          // final e so um UPDATE (a linha "proposta" pro INSERT precisa
          // ser valida antes do ON CONFLICT decidir), entao precisa vir
          // preenchido mesmo sem mudar o nome do aluno.
          nome: l.aluno.nome,
          // Quitado sobrescreve o responsável pra Amanda gestora (sai da
          // fila de quem tava cobrando); fora isso só preenche se estava
          // em branco, igual o resto dos campos.
          responsavel_atual_email: l.vaiQuitar
            ? EMAIL_AMANDA_GESTORA
            : l.vaiPreencherResponsavel
            ? l.emailOperador
            : l.aluno.responsavel_atual_email ?? null,
          responsavel_atual_nome: l.vaiQuitar
            ? "AMANDA GESTORA"
            : l.vaiPreencherResponsavel
            ? nomeOperadorPorEmail(l.emailOperador)
            : l.aluno.responsavel_atual_nome ?? null,
          responsavel_atual_em: l.vaiQuitar || l.vaiPreencherResponsavel
            ? new Date().toISOString()
            : l.aluno.responsavel_atual_em ?? null,
          status_acionamento: l.vaiPreencherStatus
            ? l.statusAcionamento
            : l.aluno.status_acionamento ?? null,
          data_ultimo_acionamento: l.vaiPreencherData
            ? l.dataAcionamento
            : l.aluno.data_ultimo_acionamento ?? null,
          nivel_criticidade: l.vaiPreencherCriticidade
            ? l.criticidade
            : l.aluno.nivel_criticidade ?? null,
          // Cancelamento/jurídico SEMPRE sobrescreve (é sinalização de
          // segurança pra não cobrar, não um preenchimento comum de
          // campo em branco). Isso ativa o card vermelho e o bloqueio de
          // acionamento que já existem na ficha pra quem não é
          // Amanda/Fernanda/Amanda ADM.
          status_jornada: l.vaiBloquearCobranca
            ? l.bloqueioCobranca
            : l.aluno.status_jornada ?? null,
          status_atual: l.vaiBloquearCobranca
            ? l.bloqueioCobranca
            : l.aluno.status_atual ?? null,
          observacao: l.vaiBloquearCobranca
            ? `Marcado como "${l.operadorArquivo}" na planilha (Vincular Base Operacional) — só reativa quem tem acesso: Amanda, Fernanda ou Amanda ADM.`
            : l.vaiQuitar
            ? `Marcado como "${l.operadorArquivo}" na planilha (Vincular Base Operacional) — reatribuído pra Amanda gestora revisar.`
            : l.aluno.observacao ?? null,
        }));

      // A planilha pode ter mais de uma linha pro mesmo aluno (ex: vários
      // acionamentos ao longo do tempo pra mesma pessoa). Se o mesmo id de
      // aluno aparecer duas vezes num mesmo lote do upsert, o Postgres
      // rejeita o lote inteiro ("ON CONFLICT DO UPDATE command cannot
      // affect row a second time") — e como o erro não estava sendo
      // mostrado, parecia que "não tinha dado nada". Por isso: remove
      // duplicidade por id antes de gravar, mantendo a última ocorrência
      // (a com o dado mais completo/recente na planilha).
      const registrosPorId = new Map();
      for (const registro of registrosBrutos) {
        registrosPorId.set(registro.id, registro);
      }
      const registros = Array.from(registrosPorId.values());

      let atualizados = 0;
      const erros = [];

      for (let i = 0; i < registros.length; i += TAMANHO_LOTE) {
        const lote = registros.slice(i, i + TAMANHO_LOTE);
        setProgresso({ feito: i, total: registros.length });

        const { error } = await supabase.from("alunos").upsert(lote, { onConflict: "id" });

        if (error) {
          console.error("Erro no lote do Vincular Base Operacional:", error);
          erros.push(error.message || String(error));
        } else {
          atualizados += lote.length;
        }
      }

      setProgresso(null);
      setResultado({ atualizados, total: registros.length });

      if (erros.length > 0) {
        setErro(
          `Atenção: ${atualizados} de ${registros.length} foram gravados. Alguns lotes falharam: ${erros[0]}`
        );
      } else {
        setPreview(null);
      }
    } catch (err) {
      console.error(err);
      setErro("Erro ao vincular: " + (err?.message || String(err)));
    } finally {
      setImportando(false);
    }
  }

  return (
    <div className="main">
      <h1>Vincular base operacional</h1>
      <p style={{ opacity: 0.75, marginBottom: 20 }}>
        Sobe a planilha da base operacional. Casa por nome do aluno, e carrega operador da
        mensalidade (vira responsável), status do acionamento, data do último acionamento e
        nível de criticidade. Nada é gravado até confirmar.
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
          <p style={{ fontSize: 13, opacity: 0.75, marginBottom: 10 }}>
            Lendo a aba: <strong>{preview.abaUsada}</strong>
          </p>
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
              <div style={estilos.label}>Vão ser atualizados (ainda não foram)</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(239,68,68,0.12)" }}>
              <div style={{ ...estilos.numero, color: "#fca5a5" }}>
                {preview.totais.bloqueiosCobranca}
              </div>
              <div style={estilos.label}>Cancelamento/Jurídico (sai da cobrança)</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(34,197,94,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#86efac" }}>
                {preview.totais.quitados}
              </div>
              <div style={estilos.label}>Quitados (vão pra sua fila)</div>
            </div>
          </div>

          {preview.operadoresNaoReconhecidos.length > 0 && (
            <p style={{ fontSize: 13, color: "#fcd34d", marginTop: 12 }}>
              Valores na coluna de operador que não reconheci como operador real (não vão
              virar responsável, só ignorados nesse campo):{" "}
              {preview.operadoresNaoReconhecidos.join(", ")}
            </p>
          )}

          {preview.contagemPorOperador.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
                Alunos por operador (na planilha, já cadastrados no CRM)
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                  gap: 8,
                }}
              >
                {preview.contagemPorOperador.map((op) => (
                  <div
                    key={op.nome}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 13,
                    }}
                  >
                    <span>{op.nome}</span>
                    <strong>{op.qtd}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div
            style={{
              marginTop: 16,
              padding: "12px 14px",
              borderRadius: 8,
              background: "rgba(251,191,36,0.12)",
              border: "1px solid rgba(251,191,36,0.4)",
              color: "#fcd34d",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            ⚠️ Isso ainda é só a prévia. Nada foi gravado no sistema. Clique no botão abaixo
            para confirmar e salvar de verdade.
          </div>

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
