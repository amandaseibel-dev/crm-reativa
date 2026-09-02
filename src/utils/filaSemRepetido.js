// UMA PESSOA, UMA LINHA NA FILA -- MAS SO QUANDO E MESMO A MESMA PESSOA.
//
// Joao, 01/09/2026: o mesmo aluno duas vezes seguidas na fila -- Gabriela
// Moraes e Raquel Marques Kruse, mesmo CPF e mesma matricula, uma linha com o
// valor consolidado e a outra com "Revisar valor".
//
// A carga da carteira ja deduplicava por `id` durante a paginacao, mas as
// listas que vem dos CARDS (retornos de hoje, risco de perder, acordo
// quebrado, retornos ADM) NAO passavam por essa trava: cada uma monta o array
// de outro jeito -- paginacao propria em `buscarTudo`, ou uma lista de ids
// devolvida por RPC -- e nenhum desses caminhos garante id unico. Deduplicar
// so na carga era trancar uma porta e deixar as outras quatro abertas.
//
// POR QUE CPF SOZINHO NAO SERVE COMO CHAVE (medido em 02/09/2026):
// existem 17 CPFs repetidos na base e em NOVE deles os dois cadastros tem
// nomes de pessoas DIFERENTES -- e CPF digitado errado no cadastro manual, nao
// duplicidade. Tres desses pares estao visiveis na fila ao mesmo tempo:
//
//   Kalany Silva da Costa (R$ 1.700,38)      x Karen Maria Warpechowski (R$ 1.400,26)
//   Franck Gasparoni (R$ 21.890,19)          x Maria Eduarda Suris Barreira (R$ 6.051,71)
//
// Juntar por CPF apagaria da fila um devedor real de R$ 21 mil. Por isso a
// regra e CPF **e** nome compativel. Sem as duas coisas, ficam duas linhas.
//
// Comparacao de nome tolerante ao que muda entre um cadastro e outro: acentos,
// caixa, espacos e as particulas "de/da/do/das/dos/e". E o que junta
// "Maria do Socorro de Jesus Cabral Neves" com "Maria do Socorro Jesus Cabral
// Neves" (mesma pessoa, cadastrada duas vezes pelo Diego) sem encostar em
// Kalany x Karen. Compara os DOIS campos de nome -- `nome` e `nome_aluno` --
// porque ha 64 registros na base com `nome_aluno` sobrescrito com o nome de
// outra pessoa: basta um dos dois casar.
//
// ESCONDER LINHA COM SALDO PROPRIO E PIOR DO QUE MOSTRAR REPETIDO. Quando os
// DOIS cadastros da mesma pessoa tem saldo (>= R$ 5), a fila mantem os dois e
// avisa. Foi o que sobrou em 02/09/2026 depois das fusoes: Aigo Silva
// (R$ 4.072,31 com a Rafaella x R$ 4.992,46 com o Diego) e Maria do Socorro
// (R$ 2.249,67 x R$ 2.624,61), os dois com ACORDO ATIVO nos dois cadastros --
// a trava `tg_acordo_bloquear_duplicado` recusa a fusao, e com razao: decidir
// qual acordo vale e da gestao. Se a fila colapsasse esses pares, sumiria
// R$ 7.617,07 da cobranca sem ninguem perceber.
//
// Entao: colapsa so quando a linha absorvida NAO tem saldo proprio. Ela leva
// `_duplicados`. Havendo saldo dos dois lados, as duas ficam com
// `_repetidoNaFila`. E quem tem CPF batendo com o de OUTRA pessoa leva
// `_cpfConflitante`. A tela AVISA em vez de sumir com o problema em silencio:
// unificar cadastro, decidir acordo e corrigir CPF sao decisoes da gestao.

// Abaixo disso o caso ja nao entra na fila (mesma regra do SALDO_MINIMO_FILA
// da carteira), entao absorver a linha nao esconde cobranca nenhuma.
const SALDO_QUE_IMPORTA = 5;

const PARTICULAS = new Set(["DE", "DA", "DO", "DAS", "DOS", "E"]);

export function cpfDaLinha(a) {
  const digitos = String((a && a.cpf) || "").replace(/\D/g, "");
  // Menos de 9 digitos nao e CPF (ja apareceu nome inteiro gravado no campo);
  // agrupar por lixo juntaria pessoas diferentes numa linha so.
  return digitos.length >= 9 && digitos.length <= 11 ? digitos.padStart(11, "0") : "";
}

// Nome reduzido ao que nao muda entre dois cadastros da mesma pessoa.
function chaveNome(valor) {
  const limpo = String(valor || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((p) => p && !PARTICULAS.has(p));
  return limpo.join(" ");
}

// Os dois cadastros falam da mesma pessoa? Basta um dos campos de nome casar.
function mesmoNome(a, b) {
  const nomesA = [chaveNome(a && a.nome), chaveNome(a && a.nome_aluno)].filter(Boolean);
  const nomesB = [chaveNome(b && b.nome), chaveNome(b && b.nome_aluno)].filter(Boolean);
  if (!nomesA.length || !nomesB.length) return false;
  return nomesA.some((n) => nomesB.includes(n));
}

export function umaLinhaPorPessoa(lista) {
  const vistosId = new Set();
  const ondeCpf = new Map(); // cpf -> indices ja colocados na saida
  const saida = [];

  const maisCompleta = (a, b) => {
    const ta = new Date((a && a.data_ultimo_acionamento) || 0).getTime() || 0;
    const tb = new Date((b && b.data_ultimo_acionamento) || 0).getTime() || 0;
    if (ta !== tb) return ta > tb ? a : b;
    return Number((b && b.saldo_total) || 0) > Number((a && a.saldo_total) || 0) ? b : a;
  };

  for (const linha of lista || []) {
    if (!linha) continue;

    const id = linha.id == null ? "" : String(linha.id);
    if (id) {
      if (vistosId.has(id)) continue; // mesma linha: nao repete
      vistosId.add(id);
    }

    const cpf = cpfDaLinha(linha);
    if (!cpf) {
      // Sem CPF utilizavel nao da para afirmar que e a mesma pessoa: mantem.
      saida.push(linha);
      continue;
    }

    const irmas = ondeCpf.get(cpf);
    if (!irmas) {
      ondeCpf.set(cpf, [saida.length]);
      saida.push(linha);
      continue;
    }

    const posicao = irmas.find((i) => mesmoNome(saida[i], linha));
    if (posicao === undefined) {
      // Mesmo CPF, outra pessoa: CPF digitado errado em algum dos cadastros.
      // As duas linhas ficam -- e as duas avisam.
      irmas.forEach((i) => { saida[i] = { ...saida[i], _cpfConflitante: true }; });
      irmas.push(saida.length);
      saida.push({ ...linha, _cpfConflitante: true });
      continue;
    }

    const jaEstava = saida[posicao];
    const fica = maisCompleta(jaEstava, linha);
    const sai = fica === jaEstava ? linha : jaEstava;
    const saldoDeQuemSairia = Number(sai && sai.saldo_total);

    if (Number.isFinite(saldoDeQuemSairia) && saldoDeQuemSairia >= SALDO_QUE_IMPORTA) {
      // As duas tem dinheiro proprio: mostra as duas, avisando.
      irmas.forEach((i) => { saida[i] = { ...saida[i], _repetidoNaFila: true }; });
      irmas.push(saida.length);
      saida.push({ ...linha, _repetidoNaFila: true });
      continue;
    }

    saida[posicao] = {
      ...fica,
      _duplicados: (jaEstava._duplicados || 0) + 1,
      ...(jaEstava._cpfConflitante ? { _cpfConflitante: true } : {}),
      ...(jaEstava._repetidoNaFila ? { _repetidoNaFila: true } : {}),
    };
  }

  return saida;
}
