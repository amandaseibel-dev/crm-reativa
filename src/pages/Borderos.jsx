import { useState } from "react";
import {
  motivoDeNaoTocar,
  chaveCpf,
  indexarAlunosPorCpf,
  fichasParaCriar,
  alunoDaLinha,
} from "../utils/bordero";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";
import { hashArquivo, hashValido } from "../utils/hashArquivo";   // MESMA implementacao
import Dobra from "../ui/blocos";

// Fonte unica da chave de identidade: `chaveCpf` em utils/bordero.js, a mesma
// usada para indexar cadastro existente, para deduplicar o lote e para resolver
// o aluno de cada linha. Antes esta funcao era uma segunda implementacao local
// -- duas copias da regra de identidade e meio caminho para divergirem.
const limparCpf = chaveCpf;

function parseValor(valor) {
  if (typeof valor === "number") return valor;
  const texto = String(valor || "")
    .replace("R$", "")
    .trim()
    .replace(/\./g, "")
    .replace(",", ".");
  const numero = parseFloat(texto);
  return Number.isNaN(numero) ? null : numero;
}

function parseDataBr(valor) {
  if (!valor) return null;
  const texto = String(valor).trim();
  const partes = texto.split("/");
  if (partes.length !== 3) return null;
  const [dia, mes, ano] = partes;
  return `${ano}-${mes.padStart(2, "0")}-${dia.padStart(2, "0")}`;
}

function extrairNumeroBordero(nomeArquivo) {
  const match = String(nomeArquivo || "").match(/(\d+)/);
  return match ? match[1] : nomeArquivo;
}

// Borderôs grandes (2-3 mil linhas) geram listas de CPF/título enormes.
// Um único .in() com milhares de valores vira uma URL de dezenas de KB e
// o gateway do Supabase rejeita ou trunca a requisição -- nesse caso
// `alunosEncontrados`/`titulosExistentes` voltam vazios (ou incompletos)
// e QUASE TUDO aparece como "novo" na prévia, mesmo quem já está
// cadastrado. Por isso as buscas por CPF, nome e título são feitas em
// lotes menores e depois unidas.
const TAMANHO_LOTE_CONSULTA = 200;

function dividirEmLotes(lista, tamanho) {
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamanho) {
    lotes.push(lista.slice(i, i + tamanho));
  }
  return lotes;
}

async function buscarEmLotes(tabela, coluna, valores, colunasSelect) {
  if (valores.length === 0) return [];
  const lotes = dividirEmLotes(valores, TAMANHO_LOTE_CONSULTA);
  const resultados = await Promise.all(
    lotes.map((lote) =>
      supabase.from(tabela).select(colunasSelect).in(coluna, lote)
    )
  );

  const registros = [];
  for (const { data, error } of resultados) {
    if (error) {
      // Não interrompe a prévia inteira por causa de um lote -- melhor
      // avisar e seguir só com o que deu certo do que travar a tela.
      console.error(`Erro ao consultar ${tabela}.${coluna} em lote:`, error);
      continue;
    }
    registros.push(...(data || []));
  }
  return registros;
}

// Gravação também vai em lote: além do corpo da requisição poder ficar
// grande demais com milhares de linhas de uma vez, o Supabase por padrão
// só devolve as primeiras 1000 linhas de um .select() após insert/upsert
// -- com um bordero de 5-10 mil linhas isso faria a metade "sumir" da
// resposta mesmo tendo sido gravada. Vai em série (não em paralelo) pra
// não sobrecarregar o banco com um monte de upserts simultâneos.
const TAMANHO_LOTE_GRAVACAO = 500;

async function inserirEmLotes(tabela, registros) {
  if (registros.length === 0) return { dados: [], erro: null };
  const lotes = dividirEmLotes(registros, TAMANHO_LOTE_GRAVACAO);
  const dados = [];
  for (const lote of lotes) {
    const { data, error } = await supabase.from(tabela).insert(lote).select();
    if (error) return { dados, erro: error };
    dados.push(...(data || []));
  }
  return { dados, erro: null };
}

// 08/10/2026: era `upsertEmLotes` e fazia ON CONFLICT DO UPDATE. Virou
// insert-only (`ignoreDuplicates: true` => ON CONFLICT DO NOTHING) porque o
// borderô passou a só INCLUIR documento ausente. O nome mudou junto de
// propósito: uma função chamada `upsert` que não faz upsert é uma armadilha.
//
// CONSEQUÊNCIA DESTA MUDANÇA, que a gestão precisa saber: reimportar um borderô
// deixa de corrigir valor/vencimento de título que já existe. Era o único efeito
// útil do upsert, e é também o que reabria NEGOCIADO. Correção de valor de
// título existente continua possível pela ficha (ajuste de valor, que tem
// trilha própria em `titulo_valor_ajuste_historico`), nunca por reimportação.
async function inserirIgnorandoExistentesEmLotes(tabela, registros, onConflict) {
  if (registros.length === 0) return { erro: null };
  const lotes = dividirEmLotes(registros, TAMANHO_LOTE_GRAVACAO);
  for (const lote of lotes) {
    const { error } = await supabase
      .from(tabela)
      .upsert(lote, { onConflict, ignoreDuplicates: true });
    if (error) return { erro: error };
  }
  return { erro: null };
}

export default function Borderos() {
  const [arquivo, setArquivo] = useState(null);
  const [processando, setProcessando] = useState(false);
  const [preview, setPreview] = useState(null);
  const [importando, setImportando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState("");
  // O hash passa a ser calculado ao ESCOLHER o arquivo, nao na hora da captura.
  // Antes era `await hashArquivo(await arquivo.arrayBuffer())` dentro do try da
  // trilha: se falhasse, a importacao financeira ja estava concluida e a captura
  // morria no catch. Calculando aqui, a falha aparece ANTES de qualquer gravacao.
  const [arquivoHash, setArquivoHash] = useState("");

  async function selecionarArquivo(e) {
    const arquivoSelecionado = e.target.files?.[0];
    if (!arquivoSelecionado) return;

    setArquivo(arquivoSelecionado);
    setResultado(null);
    setErro("");
    setProcessando(true);

    setArquivoHash("");

    try {
      const buffer = await arquivoSelecionado.arrayBuffer();
      // identidade do arquivo, pre-requisito da importacao (ver trava em
      // confirmarImportacao). Falha aqui nao interrompe a previa: quem recusa e
      // a trava, com mensagem propria.
      try { setArquivoHash(await hashArquivo(buffer)); } catch { setArquivoHash(""); }
      const workbook = XLSX.read(buffer, { type: "array" });
      const primeiraAba = workbook.SheetNames[0];
      const linhasBrutas = XLSX.utils.sheet_to_json(workbook.Sheets[primeiraAba], {
        raw: false,
      });

      if (linhasBrutas.length === 0) {
        setErro("Não encontrei linhas nessa planilha.");
        setProcessando(false);
        return;
      }

      const linhas = linhasBrutas
        .map((linha) => ({
          cpfOriginal: linha.cpfcnpj,
          cpfLimpo: limparCpf(linha.cpfcnpj),
          nome: linha.nome,
          numTitulo: String(linha.num_titulo || "").trim(),
          numParcela: linha.num_parcela,
          vencimento: parseDataBr(linha.datavencimento),
          valor: parseValor(linha.valorparcela),
          curso: linha.NomeTipoTitulo || null,
          unidade: linha.estabNome || null,
          email: String(linha.email || "").split(";")[0].trim() || null,
          telefone: linha.dddRes && linha.foneRes
            ? `(${linha.dddRes}) ${linha.foneRes}`
            : linha.foneRes || null,
        }))
        .filter((linha) => linha.numTitulo);

      const cpfs = [...new Set(linhas.map((l) => l.cpfLimpo).filter(Boolean))];
      const titulos = [...new Set(linhas.map((l) => l.numTitulo))];

      const alunosEncontrados = await buscarEmLotes(
        "alunos",
        "cpf",
        cpfs,
        "id, nome, cpf, email, telefone, curso, unidade"
      );

      const titulosExistentes = await buscarEmLotes(
        "acordos_titulos",
        "documento",
        titulos,
        // 08/10/2026: `status` entrou junto. Conferir só `situacao` deixava
        // passar linha já liquidada -- a base tem título `VENCIDA`/`quitada`.
        "documento, situacao, status"
      );

      // Indexa por `chaveCpf` dos DOIS lados. Comparar o CPF normalizado do
      // arquivo com a coluna `alunos.cpf` crua deixava de achar ficha gravada
      // com mascara ou sem zero a esquerda (42 fichas assim em 09/10/2026) --
      // e o importador criava outra para quem ja existia.
      const mapaAlunosPorCpf = indexarAlunosPorCpf(alunosEncontrados);

      const mapaTitulos = {};
      for (const titulo of titulosExistentes) {
        mapaTitulos[titulo.documento] = titulo;
      }

      // Pra quem não bateu por CPF, tenta achar pelo nome antes de decidir
      // criar um cadastro novo.
      const nomesParaTentar = [
        ...new Set(
          linhas
            .filter((l) => !(chaveCpf(l.cpfLimpo) && mapaAlunosPorCpf[chaveCpf(l.cpfLimpo)]))
            .map((l) => String(l.nome || "").trim())
            .filter(Boolean)
        ),
      ];

      const mapaAlunosPorNome = {};
      if (nomesParaTentar.length > 0) {
        const porNome = await buscarEmLotes(
          "alunos",
          "nome",
          nomesParaTentar,
          "id, nome, cpf, email, telefone, curso, unidade"
        );

        for (const aluno of porNome) {
          mapaAlunosPorNome[aluno.nome.trim().toLowerCase()] = aluno;
        }
      }

      const linhasComStatus = linhas.map((linha) => {
        const porCpf = chaveCpf(linha.cpfLimpo)
          ? mapaAlunosPorCpf[chaveCpf(linha.cpfLimpo)]
          : null;
        const porNome = !porCpf
          ? mapaAlunosPorNome[String(linha.nome || "").trim().toLowerCase()]
          : null;
        const aluno = porCpf || porNome || null;

        return {
          ...linha,
          aluno,
          origemMatch: porCpf ? "cpf" : porNome ? "nome" : "novo",
          jaExiste: Boolean(mapaTitulos[linha.numTitulo]),
          situacaoAtual: mapaTitulos[linha.numTitulo]?.situacao || null,
          statusAtual: mapaTitulos[linha.numTitulo]?.status || null,
        };
      });

      const encontradosCpf = linhasComStatus.filter((l) => l.origemMatch === "cpf").length;
      const encontradosNome = linhasComStatus.filter((l) => l.origemMatch === "nome").length;
      const novosAlunos = linhasComStatus.filter((l) => l.origemMatch === "novo").length;
      const existentes = linhasComStatus.filter((l) => l.jaExiste).length;

      const numeroBordero = extrairNumeroBordero(arquivoSelecionado.name);

      // Avisa se esse mesmo bordero (mesmo numero) ja foi importado antes,
      // pra evitar reenvio sem perceber. Nao bloqueia (pode ser reforço de
      // dados de propósito), so deixa bem visivel antes de confirmar.
      const { data: importacoesAnteriores } = await supabase
        .from("importacoes")
        .select("id, created_at, usuario, qtd_registros")
        .eq("tipo", "BORDERO")
        .eq("referencia", numeroBordero)
        .eq("status", "CONCLUIDO")
        .order("created_at", { ascending: false })
        .limit(1);

      setPreview({
        linhas: linhasComStatus,
        totais: {
          total: linhasComStatus.length,
          encontradosCpf,
          encontradosNome,
          novosAlunos,
          existentes,
        },
        numeroBordero,
        jaImportadoAntes: importacoesAnteriores?.[0] || null,
      });
    } catch (err) {
      console.error(err);
      setErro("Não consegui ler essa planilha. Confira se é um .xls/.xlsx válido.");
    } finally {
      setProcessando(false);
    }
  }

  async function confirmarImportacao() {
    if (!preview) return;

    // ===== HASH OBRIGATORIO, ANTES DE QUALQUER GRAVACAO =====================
    // Mesmo contrato da ImportacaoAcordos: sem identidade do arquivo, a
    // importacao nao comeca. Vem antes do `setImportando` e antes do insert em
    // `importacoes`, entao nada financeiro e gravado.
    //
    // ATENCAO: isto e mais restritivo do que o bordero era. Antes, um bordero
    // cujo hash nao pudesse ser calculado importava normalmente e so perdia a
    // trilha. Agora ele e recusado. A troca e deliberada -- um bordero que nao
    // da para identificar nao da para auditar -- mas e um bloqueio novo num
    // fluxo que nunca bloqueava.
    if (!hashValido(arquivoHash)) {
      setErro("Não foi possível calcular a identidade do arquivo (SHA-256). " +
        "A importação NÃO foi iniciada: nada foi gravado. " +
        "Selecione o arquivo de novo; se persistir, confira se a página está em HTTPS.");
      return;
    }
    // ========================================================================

    setImportando(true);
    setErro("");

    try {
      const { data: userData } = await supabase.auth.getUser();
      const email = userData?.user?.email || "desconhecido";

      const { data: importacao, error: erroImportacao } = await supabase
        .from("importacoes")
        .insert({
          tipo: "BORDERO",
          referencia: preview.numeroBordero,
          arquivo_nome: arquivo?.name || null,
          usuario: email,
          qtd_registros: preview.linhas.length,
          status: "PROCESSANDO",
        })
        .select()
        .single();

      if (erroImportacao) {
        setErro("Erro ao registrar a importação: " + erroImportacao.message);
        setImportando(false);
        return;
      }

      let ignorados = 0;
      const nomesNaoEncontrados = [];
      const nomesCriados = [];

      // ---------------------------------------------------------------------
      // ===== CONTRATO (nao mover) ==========================================
      // A captura de presenca deve permanecer ANTES de qualquer filtro
      // operacional do importador -- aqui, especificamente, antes de
      // `motivoDeNaoTocar`. Nao ha teste automatizado que proteja esta
      // ordem: a garantia e a posicao no codigo. Mover e silencioso.
      // =====================================================================

      // 1) Cria os alunos que não bateram nem por CPF nem por nome --
      // ===== UM CADASTRO POR CPF, nunca um por linha ======================
      // O borderô tem uma linha por TÍTULO. Antes isto era
      // `preview.linhas.filter((l) => !l.aluno).map(...)`, e quem devia 6
      // mensalidades ganhava 6 fichas: 14 CPFs e 33 fichas no borderô 723 de
      // 08/10/2026. `fichasParaCriar` colapsa o lote por `chaveCpf`.
      // ===================================================================
      const { registros: fichasPorCpf, linhasSemCpf } = fichasParaCriar(preview.linhas);

      // Linha sem CPF continua EXATAMENTE como antes: uma ficha por linha.
      // Mudar isto agora (recusar a linha) derrubaria no chão o título que hoje
      // é gravado, e a quarentena da regra 4 de docs/PADRAO_CADASTRO.md não
      // existe. Esta importação muda UMA coisa: duplicata por CPF. O que a tela
      // ganha aqui é só a contagem, para a gestão ver o tamanho do débito.
      const fichasSemCpf = linhasSemCpf.map((l) => ({
        nome: l.nome,
        cpf: null,
        email: l.email,
        telefone: l.telefone,
        curso: l.curso,
        unidade: l.unidade,
        status_jornada: "CONTATAR",
        status_atual: "CONTATAR",
      }));

      // Os sem CPF vão DEPOIS dos por-CPF no mesmo lote: o `insert ...
      // returning` devolve na ordem de inserção, e é isso que permite ligar
      // cada linha sem CPF à ficha que nasceu dela, sem chutar por nome.
      // (Antes, todas as linhas sem CPF caíam na ÚLTIMA ficha sem CPF criada,
      // porque a chave do mapa era o `null` virando a string "null" --
      // títulos de pessoas diferentes na mesma ficha.)
      const fichasNovas = [...fichasPorCpf, ...fichasSemCpf];
      const linhasSemAluno = preview.linhas.filter((l) => !l.aluno);
      let alunosNovosPorCpf = {};
      let alunosCriados = 0;
      const alunoPorLinhaSemCpf = new Map();

      if (fichasNovas.length > 0) {
        const { dados: novosAlunos, erro: erroNovos } = await inserirEmLotes(
          "alunos",
          fichasNovas
        );

        if (erroNovos) {
          nomesNaoEncontrados.push(...linhasSemAluno.map((l) => l.nome));
          ignorados += linhasSemAluno.length;
        } else {
          alunosNovosPorCpf = indexarAlunosPorCpf(novosAlunos);
          alunosCriados = novosAlunos.length;
          nomesCriados.push(...novosAlunos.map((a) => a.nome));

          novosAlunos.slice(fichasPorCpf.length).forEach((aluno, i) => {
            if (linhasSemCpf[i]) alunoPorLinhaSemCpf.set(linhasSemCpf[i], aluno);
          });
        }
      }

      const linhasSemCpfCount = linhasSemCpf.length;

      // 2) Completa telefone/email/curso/unidade só de quem já existia e
      // estava com algum desses campos vazio — em paralelo, não em fila.
      const completar = preview.linhas.filter((l) => l.aluno).map((l) => {
        const aluno = l.aluno;
        const camposParaCompletar = {};
        if (!aluno.email && l.email) camposParaCompletar.email = l.email;
        if (!aluno.telefone && l.telefone) camposParaCompletar.telefone = l.telefone;
        if (!aluno.curso && l.curso) camposParaCompletar.curso = l.curso;
        if (!aluno.unidade && l.unidade) camposParaCompletar.unidade = l.unidade;

        if (Object.keys(camposParaCompletar).length === 0) return null;
        return supabase.from("alunos").update(camposParaCompletar).eq("id", aluno.id);
      }).filter(Boolean);

      await Promise.all(completar);

      // 3) Grava todos os títulos em uma única chamada (upsert por
      // "documento"), em vez de um insert/update por linha.
      const registrosTitulos = [];

      for (const linha of preview.linhas) {
        // ===== 08/10/2026: TITULO QUE JA EXISTE NUNCA E TOCADO ==============
        // Pedido da gestao: "inserir apenas documentos ausentes, sem atualizar
        // existentes". Antes, so PAGO / EM_CONFIRMACAO / CANCELADA eram
        // pulados, e o `upsert` reabria todo o resto -- inclusive NEGOCIADO,
        // que nenhum gatilho de banco protege.
        //
        // `motivoDeNaoTocar` devolve o porque (situacao terminal, status
        // terminal, ou simplesmente "ja existe") para a tela poder dizer.
        // ===================================================================
        const motivoIgnorar = motivoDeNaoTocar(linha);
        if (motivoIgnorar) {
          ignorados += 1;
          continue;
        }

        const aluno =
          alunoDaLinha(linha, alunosNovosPorCpf) || alunoPorLinhaSemCpf.get(linha) || null;
        if (!aluno) {
          ignorados += 1;
          continue;
        }

        registrosTitulos.push({
          aluno_id: aluno.id,
          cpf: linha.cpfLimpo,
          documento: linha.numTitulo,
          vencimento: linha.vencimento,
          valor_original: linha.valor,
          saldo_corrigido: linha.valor,
          situacao: "ABERTO",
          tipo_boleto: linha.curso,
          importacao_id: importacao.id,
        });
      }

      let inseridos = 0;
      let atualizados = 0;

      if (registrosTitulos.length > 0) {
        const { erro: erroTitulos } = await inserirIgnorandoExistentesEmLotes(
          "acordos_titulos",
          registrosTitulos,
          "documento"
        );

        if (erroTitulos) {
          setErro("Erro ao gravar os títulos: " + erroTitulos.message);
        } else {
          // `registrosTitulos` já não contém nenhum título existente (todos
          // caíram no `motivoDeNaoTocar` acima), então tudo que foi gravado é
          // inserção. `atualizados` fica 0 por construção, e continua exposto
          // na tela para deixar explícito que a importação não atualiza.
          inseridos = registrosTitulos.length;
          atualizados = 0;

          // ===== SALDO DO ALUNO, DEPOIS DE GRAVAR O TÍTULO ==============
          // Medido em 09/10/2026: 485 alunos tinham título cobrável em aberto
          // e `alunos.saldo_total` NULO -- R$ 692.047,04 de dívida que existia
          // em `acordos_titulos` e não aparecia no campo que a carteira, as
          // filas e os indicadores leem. A causa: `acordos_titulos` não tinha
          // gatilho de recálculo (todas as outras tabelas financeiras têm) e a
          // virada diária varre `from casos` -- quem não tem caso nunca era
          // alcançado.
          //
          // O gatilho de instrução da migration 20261009210000 enfileira os
          // alunos em `recalculo_saldo_pendente`; aqui a fila é drenada no
          // mesmo ato da importação, para o saldo já estar certo quando a
          // operadora abrir a tela. A fila é durável: se isto falhar, o
          // pendente continua registrado e a próxima chamada processa.
          //
          // FAIL-SOFT de propósito: recalcular saldo é campo derivado. Se
          // quebrar, a importação -- que é o ato financeiro -- não cai por
          // causa disso.
          try {
            let restantes = Infinity;
            // teto de voltas: um borderô tem ~2.000 alunos; 10 x 500 cobre
            // com folga e impede laço infinito se o RPC parar de drenar.
            for (let volta = 0; volta < 10 && restantes > 0; volta += 1) {
              const { data: dreno, error: erroDreno } = await supabase.rpc(
                "recalculo_saldo_pendente_processar",
                { p_limite: 500, p_lote: `bordero_${preview.numeroBordero || "sn"}` }
              );
              if (erroDreno) break;
              restantes = Number(dreno?.restantes ?? 0);
            }
          } catch { /* campo derivado; ver o comentário acima */ }

          // ===== 08/10/2026: SEPARADO EM DOIS ===========================
          // Este bloco fazia TRÊS coisas de uma vez, e só a primeira é fila:
          //
          //   1. tirava o aluno de QUITADO/QUITADO_MANUAL e devolvia para
          //      CONTATAR  -> MANTIDO. É promessa explícita do produto, dita
          //      ao operador em dois lugares ("Só volta se subir um título
          //      novo dele em algum borderô"), e agora ela fica ainda mais
          //      exata: com o importador insert-only, só dispara quando
          //      entra título REALMENTE novo.
          //
          //   2. restaurava o saldo de títulos `quitada` com motivo "quitado
          //      manualmente"                              -> DESLIGADO
          //   3. devolvia parcela PAGO sem data para A_VENCER e REATIVAVA o
          //      acordo QUITADO                            -> DESLIGADO
          //
          // 2 e 3 são exatamente o que a gestão proibiu em 08/10/2026: "não
          // reative parcelas negociadas, pagas, quitadas, suspensas,
          // canceladas, devolvidas ou encerradas, incluindo acordos e
          // vínculos financeiros". Ficam no código atrás de um interruptor
          // desligado, não apagados: religar é decisão de negócio.
          //
          // Dívida nova de aluno quitado continua entrando como título e
          // continua trazendo a ficha para a fila. O que não acontece mais é
          // o CRM desfazer sozinho uma quitação e reabrir o acordo.
          // ==============================================================
          const RESTAURAR_QUITACAO_NO_BORDERO = false;
          const idsAlunosComTitulo = [
            ...new Set(registrosTitulos.map((r) => r.aluno_id)),
          ];
          if (idsAlunosComTitulo.length > 0) {
            // Descobre quais desses alunos estavam quitados -- só esses são
            // reativados/restaurados (não mexe em atendimento em andamento
            // nem em casos travados tipo jurídico).
            const { data: quitados } = await supabase
              .from("alunos")
              .select("id")
              .in("id", idsAlunosComTitulo)
              .in("status_jornada", ["QUITADO", "QUITADO_MANUAL"]);

            const idsQuitados = (quitados || []).map((a) => String(a.id));

            if (idsQuitados.length > 0) {
              const agora = new Date().toISOString();

              // 1) Volta pra fila ativa.
              await supabase
                .from("alunos")
                .update({
                  status_jornada: "CONTATAR",
                  status_atual: "CONTATAR",
                  status_acionamento: "CONTATAR",
                  proxima_acao: "CONTATAR",
                })
                .in("id", idsQuitados);

              // 2) e 3) DESLIGADAS em 08/10/2026 (ver o bloco acima). Desfazer
              // uma quitação e reabrir acordo é reativação de registro
              // financeiro, não movimento de fila — e a trava do banco
              // (migration 20261008120000) recusaria a 2) de qualquer jeito.
              if (RESTAURAR_QUITACAO_NO_BORDERO) {
              // 2) Restaura o saldo dos títulos que a quitação manual zerou
              // (reconhecidos pelo motivo_ajuste). Não toca em títulos pagos
              // de verdade nem em vinculados a acordo ativo.
              const { data: titsZerados } = await supabase
                .from("acordos_titulos")
                .select("id, valor_original")
                .in("aluno_id", idsQuitados)
                .eq("status", "quitada")
                .ilike("motivo_ajuste", "%quitado manualmente%");

              for (const t of titsZerados || []) {
                await supabase
                  .from("acordos_titulos")
                  .update({
                    situacao: "ABERTO",
                    status: "em_aberto",
                    saldo_corrigido: t.valor_original,
                    valor_em_aberto: t.valor_original,
                    motivo_ajuste: "Saldo restaurado por nova importação",
                    atualizado_em: agora,
                  })
                  .eq("id", t.id);
              }

              // 3) Reabre as parcelas que a quitação manual "pagou" sem data
              // (PAGO + pago_em nulo é a assinatura da quitação manual;
              // pagamento de verdade sempre tem data) e reativa esses acordos,
              // recalculando o saldo pela soma das parcelas em aberto.
              const { data: acordosQuit } = await supabase
                .from("acordos")
                .select("id")
                .in("aluno_id", idsQuitados)
                .eq("status", "QUITADO");

              const idsAcordos = (acordosQuit || []).map((a) => a.id);

              if (idsAcordos.length > 0) {
                await supabase
                  .from("parcelas")
                  .update({ status: "A_VENCER", atualizado_em: agora })
                  .in("acordo_id", idsAcordos)
                  .eq("status", "PAGO")
                  .is("pago_em", null);

                // Recalcula o saldo de cada acordo e só reativa os que
                // voltaram a ter parcela em aberto.
                const { data: parcelasAcordos } = await supabase
                  .from("parcelas")
                  .select("acordo_id, valor, status")
                  .in("acordo_id", idsAcordos);

                const saldoPorAcordo = {};
                (parcelasAcordos || []).forEach((p) => {
                  if (p.status !== "PAGO" && p.status !== "CANCELADA") {
                    saldoPorAcordo[p.acordo_id] =
                      (saldoPorAcordo[p.acordo_id] || 0) + Number(p.valor || 0);
                  }
                });

                for (const acordoId of idsAcordos) {
                  const saldo = saldoPorAcordo[acordoId] || 0;
                  if (saldo > 0) {
                    await supabase
                      .from("acordos")
                      .update({ status: "ATIVO", saldo, atualizado_em: agora })
                      .eq("id", acordoId);
                  }
                }
              }
              }   // fim do if (RESTAURAR_QUITACAO_NO_BORDERO)
            }
          }
        }
      }

      await supabase
        .from("importacoes")
        .update({ status: "CONCLUIDO" })
        .eq("id", importacao.id);

      // =====================================================================
      // J3/I2 — PRESENCA DO ARQUIVO BRUTO.
      //
      // ORDEM (corrigida em 01/10): a captura vem DEPOIS de a importacao
      // financeira CONCLUIR. Antes ela rodava no inicio de
      // `confirmarImportacao`, e o motivo documentado era outro -- garantir que
      // as linhas puladas pelo laco entrassem no registro. Esse motivo nao
      // exige rodar antes: `preview.linhas` e o arquivo inteiro e continua
      // disponivel aqui. Capturando antes, uma importacao que estourasse no
      // meio deixava a trilha afirmando que uma extracao foi recebida enquanto
      // a `importacoes` ficava em PROCESSANDO -- uma extracao registrada sem
      // importacao concluida.
      //
      // O QUE A CAPTURA PRECISA MANTER, e mantem: TODAS as linhas do arquivo,
      // inclusive as que o laco acima pula via `motivoDeNaoTocar(linha)` --
      // que a partir de 08/10/2026 e TODO titulo ja existente, nao so os
      // terminais -- e as sem aluno resolvido. Se a trilha repetisse o filtro
      // do importador, a ausencia medida seria artefato nosso, nao do arquivo.
      // =====================================================================
      try {
        await supabase.rpc("registrar_presenca_extracao", {
          p_importacao_id: importacao.id,
          p_source_type: "BORDERO",
          // o bordero E o escopo: comparar bordero 545 com 617 nao faz sentido,
          // sao populacoes diferentes por construcao.
          p_scope_key: "BORDERO=" + String(preview.numeroBordero || "DESCONHECIDO"),
          // CONTRATO DO BORDERO (aprovado em 01/10):
          //   · serve para AUDITORIA DE PRESENCA;
          //   · normalmente NAO tera snapshot comparavel seguinte (cada bordero
          //     e importado ~1 vez: 93 referencias em 97 importacoes);
          //   · portanto NAO gera inferencia de ausencia;
          //   · NAO participa da sequencia TOTAL do portador 195;
          //   · NAO e comparado com BORDERO=TODOS -- scope_key diferente, e o
          //     CHECK ck_extracao_scope_key_coerente garante a separacao.
          // TOTAL aqui significa "o lote inteiro DESTA remessa", nao a carteira.
          p_completude: "TOTAL",
          // instante do upload, nao da geracao do bordero: o arquivo nao traz
          // data de geracao. Inofensivo aqui porque cada bordero tem scope_key
          // propria -- existe no maximo UMA extracao por escopo, logo nao ha
          // ordem a inverter. No relatorio, onde todas as extracoes dividem a
          // mesma scope_key, a data E declarada pela gestao.
          p_snapshot_at: new Date().toISOString(),
          p_arquivo_nome: arquivo?.name || null,
          // hash ja calculado no `selecionarArquivo` e conferido pela trava
          p_arquivo_hash: arquivoHash,
          p_linhas_arquivo: preview.linhas.length,
          p_linhas: preview.linhas.map((l) => ({
            documento: l.numTitulo,
            cpf: l.cpfLimpo,
            tipo_boleto: l.curso,
            // CORRIGIDO em 01/10: antes ia `l.situacaoAtual || "ABERTO"`.
            // `situacaoAtual` e a situacao QUE O CRM TEM para o titulo
            // (`mapaTitulos[numTitulo].situacao`), nao algo que o arquivo diga
            // -- o bordero nao tem coluna de situacao. Gravar aquilo era
            // guardar estado nosso como se fosse conteudo do arquivo, e o
            // fallback literal "ABERTO" inventava uma situacao para todo
            // titulo que o CRM ainda nao conhecia. A trilha representa O
            // ARQUIVO RECEBIDO: sem coluna no arquivo, sem valor aqui.
            situacao: null,
            valor: l.valor,
            venc: l.vencimento,
          })),
        });
      } catch { /* presenca e auditoria paralela; nao derruba a importacao */ }

      setResultado({
        inseridos, atualizados, ignorados, alunosCriados, nomesCriados,
        nomesNaoEncontrados,
        linhasSemCpf: linhasSemCpfCount,
      });
      setPreview(null);
      setArquivo(null);
    } catch (err) {
      console.error(err);
      setErro("Erro ao importar. Tente novamente.");
    } finally {
      setImportando(false);
    }
  }

  return (
    <div className="main">
      <h1>Borderôs</h1>
      <p style={{ opacity: 0.75, marginBottom: 20 }}>
        Sobe a planilha de mensalidades/parcelas em aberto. Casa por CPF e não duplica
        títulos já importados — só atualiza. Nada é gravado até você confirmar.
      </p>

      <div style={estilos.caixaUpload}>
        <input type="file" accept=".xls,.xlsx" onChange={selecionarArquivo} />
        {processando && <p style={{ marginTop: 10 }}>Lendo planilha...</p>}
      </div>

      {erro && <p style={{ color: "#f87171", marginTop: 12 }}>{erro}</p>}

      {resultado && (
        <div style={estilos.caixaSucesso}>
          <strong>Importação concluída.</strong>
          <p style={{ margin: "6px 0 0" }}>
            {resultado.inseridos} títulos novos, {resultado.atualizados} atualizados,{" "}
            {resultado.alunosCriados} alunos novos cadastrados, {resultado.ignorados}{" "}
            ignorados (já pagos).
          </p>

          {resultado.linhasSemCpf > 0 && (
            <p style={{ margin: "6px 0 0" }}>
              <strong>{resultado.linhasSemCpf}</strong> linha(s) vieram sem CPF. Sem
              CPF não existe correspondência segura: cada uma virou um cadastro
              próprio e pode ser a mesma pessoa de outra linha. Confira essas
              fichas antes de acionar.
            </p>
          )}

          {resultado.nomesCriados?.length > 0 && (
            <Dobra
              tema="escuro"
              titulo="Alunos criados agora"
              contador={resultado.nomesCriados.length}
              style={{ marginTop: 10 }}
            >
              <ul style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>
                {resultado.nomesCriados.map((nome, indice) => (
                  <li key={indice}>{nome}</li>
                ))}
              </ul>
            </Dobra>
          )}

          {resultado.nomesNaoEncontrados?.length > 0 && (
            <Dobra
              tema="escuro"
              titulo="Não importados"
              contador={resultado.nomesNaoEncontrados.length}
              estiloSumario={{ color: "#fcd34d" }}
              style={{ marginTop: 10 }}
            >
              <ul style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>
                {resultado.nomesNaoEncontrados.map((nome, indice) => (
                  <li key={indice}>{nome}</li>
                ))}
              </ul>
            </Dobra>
          )}
        </div>
      )}

      {preview && (
        <div style={{ marginTop: 20 }}>
          {preview.jaImportadoAntes && (
            <div style={estilos.avisoDuplicado}>
              <strong>⚠️ Este borderô (nº {preview.numeroBordero}) já foi importado antes</strong>
              <p style={{ margin: "4px 0 0", fontSize: 13 }}>
                Em {new Date(preview.jaImportadoAntes.created_at).toLocaleString("pt-BR")}, por{" "}
                {preview.jaImportadoAntes.usuario} ({preview.jaImportadoAntes.qtd_registros}{" "}
                registros). Confirmar de novo não duplica os títulos, só atualiza os valores —
                mas confira se é isso mesmo que você quer antes de continuar.
              </p>
            </div>
          )}

          <div style={estilos.grade}>
            <div style={estilos.cartao}>
              <div style={estilos.numero}>{preview.totais.total}</div>
              <div style={estilos.label}>Total no arquivo</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(34,197,94,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#93c5fd" }}>
                {preview.totais.encontradosCpf}
              </div>
              <div style={estilos.label}>Encontrados por CPF</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(56,189,248,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#7dd3fc" }}>
                {preview.totais.encontradosNome}
              </div>
              <div style={estilos.label}>Encontrados pelo nome</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(251,191,36,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#fcd34d" }}>
                {preview.totais.novosAlunos}
              </div>
              <div style={estilos.label}>Alunos novos (serão criados)</div>
            </div>
            <div style={estilos.cartao}>
              <div style={estilos.numero}>{preview.totais.existentes}</div>
              <div style={estilos.label}>Títulos já existentes</div>
            </div>
          </div>

          <p style={{ fontSize: 13, opacity: 0.75, margin: "16px 0 8px" }}>
            Prévia das primeiras linhas
          </p>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(148,163,184,0.3)" }}>
                  <th style={{ padding: "8px 10px" }}>Aluno</th>
                  <th style={{ padding: "8px 10px" }}>Título</th>
                  <th style={{ padding: "8px 10px" }}>Vencimento</th>
                  <th style={{ padding: "8px 10px" }}>Valor</th>
                  <th style={{ padding: "8px 10px" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.linhas.slice(0, 20).map((linha, indice) => (
                  <tr key={indice} style={{ borderBottom: "1px solid rgba(148,163,184,0.12)" }}>
                    <td style={{ padding: "8px 10px" }}>{linha.nome}</td>
                    <td style={{ padding: "8px 10px", opacity: 0.7 }}>{linha.numTitulo}</td>
                    <td style={{ padding: "8px 10px" }}>
                      {linha.vencimento
                        ? new Date(linha.vencimento + "T00:00:00").toLocaleDateString("pt-BR")
                        : "-"}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {linha.valor != null
                        ? linha.valor.toLocaleString("pt-BR", {
                            style: "currency",
                            currency: "BRL",
                          })
                        : "-"}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {linha.origemMatch === "novo" ? (
                        <span style={estilos.tagAmarela}>Aluno novo (será criado)</span>
                      ) : linha.jaExiste ? (
                        <span style={estilos.tagNeutra}>Já existe (atualiza)</span>
                      ) : linha.origemMatch === "nome" ? (
                        <span style={estilos.tagAzul}>Encontrado pelo nome</span>
                      ) : (
                        <span style={estilos.tagVerde}>Encontrado</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            onClick={confirmarImportacao}
            disabled={importando}
            style={estilos.botaoConfirmar}
          >
            {importando ? "Importando..." : "Confirmar importação"}
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
  avisoDuplicado: {
    padding: "12px 16px",
    marginBottom: 16,
    borderRadius: 10,
    background: "rgba(251,191,36,0.1)",
    border: "1px solid rgba(251,191,36,0.4)",
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
    fontSize: 24,
    fontWeight: 800,
  },
  label: {
    fontSize: 12,
    opacity: 0.75,
    marginTop: 4,
  },
  tagVerde: {
    background: "rgba(34,197,94,0.16)",
    color: "#93c5fd",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  tagAmarela: {
    background: "rgba(251,191,36,0.16)",
    color: "#fcd34d",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  tagNeutra: {
    background: "rgba(148,163,184,0.15)",
    color: "#cbd5e1",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  tagAzul: {
    background: "rgba(56,189,248,0.16)",
    color: "#7dd3fc",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  botaoConfirmar: {
    marginTop: 16,
    padding: "10px 20px",
    borderRadius: 8,
    border: "1px solid rgba(34,197,94,0.6)",
    background: "rgba(34,197,94,0.16)",
    color: "#93c5fd",
    fontWeight: 600,
    cursor: "pointer",
  },
};
