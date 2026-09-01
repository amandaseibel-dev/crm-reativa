// Lançar acordo no sistema -- uma regra só, dois lugares.
//
// POR QUE ESTE ARQUIVO EXISTE. O acordo sempre existe de verdade lá fora
// (Amanda, 26/08/2026: "o acordo sempre existe de verdade, só preciso lançar no
// sistema"). O que faltava era um caminho de lançamento que não obrigasse a
// abrir a ficha inteira de cada aluno, um por um, com o relatório do Santander
// do lado.
//
// A tentação seria escrever esse caminho novo do zero. Foi exatamente assim que
// nasceram os 88 acordos duplicados lançados na mão: o cadastro manual tinha
// regra própria e passava por fora da trava da importação. Então a regra de
// gravar mora AQUI, e tanto a ficha quanto a tela de lançamento chamam a mesma
// função. Se um dia a regra mudar, muda nos dois ao mesmo tempo -- não tem como
// esquecer um.
//
// O QUE A REGRA GARANTE, em ordem:
//   1. entrada é parcela de verdade (número 0), paga ou não;
//   2. entrada paga vira pagamento + baixa, senão não entra em KPI nenhum;
//   3. entrada NÃO paga também vira parcela, senão o valor some da cobrança:
//      o parcelado é gerado sobre (total - entrada) e o saldo já desconta ela;
//   4. o honorário é rateado proporcionalmente, com a última parcela levando a
//      diferença de centavos -- a soma das parcelas fecha com o do acordo;
//   5. o dono do caso é o responsável atual do ALUNO, não quem apertou salvar.

import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "./operadores";

export function paraNumero(v) {
  let t = String(v || "").replace("R$", "").replace(/\s/g, "").trim();
  const temVirgula = t.includes(",");
  const temPonto = t.includes(".");
  if (temVirgula && temPonto) t = t.replace(/\./g, "").replace(",", ".");
  else if (temVirgula) t = t.replace(",", ".");
  return Number(t) || 0;
}

export function paraDataISO(v) {
  const t = String(v || "").trim();
  if (!t) return "";
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let d = m[1], mo = m[2], ano = m[3];
    if (ano.length === 2) ano = "20" + ano;
    return `${ano}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

export function paraDataBR(v) {
  const t = String(v || "").trim();
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return t;
}

export function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function somarMeses(dataISO, meses) {
  const [ano, mes, dia] = String(dataISO).split("-").map(Number);
  const totalMeses = mes - 1 + meses;
  const anoFinal = ano + Math.floor(totalMeses / 12);
  const mesFinal = (totalMeses % 12) + 1;
  const ultimoDiaMes = new Date(anoFinal, mesFinal, 0).getDate();
  const diaFinal = Math.min(dia, ultimoDiaMes);
  return `${anoFinal}-${String(mesFinal).padStart(2, "0")}-${String(diaFinal).padStart(2, "0")}`;
}

// Monta a grade de parcelas a partir do combinado do acordo.
//
// O honorário é rateado PROPORCIONALMENTE ao valor: a entrada leva a fatia dela
// (entrada/total) e o resto se divide entre as parcelas. Rateio por quantidade
// dava número errado quando a entrada tinha valor diferente das demais -- que é
// justamente o caso normal.
export function gerarParcelas({ valorTotal, qtdParcelas, temEntrada, entradaRs, honorarios, primeiroVenc }) {
  const total = paraNumero(valorTotal);
  if (total <= 0) return { erro: "Informe o valor total do acordo.", parcelas: [], honorariosEntrada: "0" };

  const qtd = Math.max(1, parseInt(qtdParcelas) || 1);
  const entrada = temEntrada ? Math.min(paraNumero(entradaRs), total) : 0;
  const honTotal = paraNumero(honorarios);
  const saldo = Math.max(0, total - entrada);
  const vParc = saldo / qtd;
  const honEnt = total > 0 ? honTotal * (entrada / total) : 0;
  const honSaldo = Math.max(0, honTotal - honEnt);
  const honCada = honSaldo / qtd;
  const base = paraDataISO(primeiroVenc) || hojeISO();

  // A ULTIMA PARCELA LEVA A DIFERENCA DO ARREDONDAMENTO.
  //
  // Sem isso, 2.000 em 3x vira 666,67 tres vezes = 2.000,01: as parcelas somam
  // MAIS do que o acordo. Um centavo parece nada, mas e um centavo em todo
  // acordo cujo valor nao divide certo -- que e quase todo acordo -- e faz a
  // conferencia contra o relatorio nunca fechar exatamente.
  const parcelas = [];
  let acumulado = 0;
  let acumuladoHon = 0;
  for (let i = 1; i <= qtd; i++) {
    const ultima = i === qtd;
    const valor = ultima ? saldo - acumulado : Number(vParc.toFixed(2));
    const hon = ultima ? honSaldo - acumuladoHon : Number(honCada.toFixed(2));
    acumulado += valor;
    acumuladoHon += hon;
    parcelas.push({
      numero: i,
      vencimento: paraDataBR(somarMeses(base, i - 1)),
      valor: valor.toFixed(2),
      honorarios: hon.toFixed(2),
      status: "A_VENCER",
    });
  }
  return { erro: "", parcelas, honorariosEntrada: honEnt.toFixed(2) };
}

// Grava o acordo, as parcelas, a entrada e (se paga) o pagamento + a baixa.
//
// Devolve { ok, acordo, avisos }. `avisos` é para o que gravou pela metade e
// precisa de conserto na mão -- nunca fica escondido no console.
export async function lancarAcordo({ aluno, dados, usuarioEmail }) {
  const total = paraNumero(dados.valorTotal);
  if (total <= 0) return { ok: false, erro: "Informe o valor total do acordo." };
  if (!dados.parcelas?.length) return { ok: false, erro: 'Gere as parcelas antes de salvar.' };

  // Amanda, 01/09/2026: "quando fechamos o acordo obrigatoriamente devemos
  // vincular as mensalidades que vamos negociar".
  //
  // A obrigacao existia no processo e nao no sistema: 47% dos acordos fechados
  // na tela sairam sem composicao (185 de 388). Sem o vinculo a mensalidade
  // continua ABERTA e o acordo tambem conta -- a mesma divida entra duas vezes
  // no saldo. Foi o caso do Jose Luiz de Assis Neto: R$ 2.400,53 de mensalidade
  // mais R$ 3.007,12 de acordo, para uma divida so.
  //
  // A checagem vive AQUI, e nao na tela, porque esta funcao e a porta unica de
  // lancamento -- ficha e bancada chamam ela. Quem fecha nao consegue passar
  // por fora, nem hoje nem numa tela nova.
  //
  // Nao da para adivinhar a composicao depois: ela nao existe em fonte nenhuma
  // -- nem no Prime (`agreements` vazio, boletos de acordo ausentes do extrato),
  // nem no relatorio da Ulbra, nem no arquivo de pagamento. So quem negociou
  // sabe. Por isso se pergunta na hora.
  const selecionados = Array.isArray(dados.titulosSel) ? dados.titulosSel : [];
  if (selecionados.length === 0 && !dados.semComposicaoConfirmado) {
    const { data: abertos, error: erroAbertos } = await supabase
      .from("acordos_titulos")
      .select("id")
      .eq("aluno_id", String(aluno.id))
      .is("acordo_id", null)
      .eq("situacao", "ABERTO")
      .limit(1);

    // Se a consulta falhar nao se inventa permissao nem bloqueio: avisa e para.
    if (erroAbertos) {
      return {
        ok: false,
        erro: "Nao foi possivel conferir as mensalidades em aberto do aluno (" +
              erroAbertos.message + "). Tente de novo antes de fechar o acordo.",
      };
    }

    if (abertos && abertos.length > 0) {
      return {
        ok: false,
        precisaComposicao: true,
        erro: "Este aluno tem mensalidade em aberto e nenhuma foi marcada. " +
              "Marque as mensalidades que entram neste acordo -- sem isso a " +
              "mesma divida passa a ser contada duas vezes.",
      };
    }
  }

  const email = usuarioEmail || "";
  const agora = new Date().toISOString();
  // Quem lança (normalmente a Amanda) quase nunca é o operador dono do caso.
  // Para carteira e KPI o dono é o responsável atual do ALUNO.
  const operadorResponsavel = aluno.responsavel_atual_email || email;
  const entrada = dados.temEntrada ? Math.min(paraNumero(dados.entradaRs), total) : 0;
  const pct = total > 0 && dados.temEntrada ? Number(((entrada / total) * 100).toFixed(2)) : null;
  const honTotal = paraNumero(dados.honorarios);
  const saldo = Math.max(0, total - entrada);
  const avisos = [];

  const { data: acordo, error } = await supabase
    .from("acordos")
    .insert({
      aluno_id: String(aluno.id),
      cpf: aluno.cpf,
      tipo: "ACORDO",
      forma_pagamento: "PARCELADO",
      valor_total: total,
      qtd_parcelas: dados.parcelas.length,
      valor_entrada: dados.temEntrada ? entrada : null,
      entrada_percentual: pct,
      entrada_paga: dados.temEntrada ? Boolean(dados.entradaPaga) : false,
      data_entrada: dados.temEntrada && dados.entradaPaga ? (paraDataISO(dados.dataEntrada) || hojeISO()) : null,
      honorarios_valor: honTotal || null,
      saldo,
      status: "ATIVO",
      operador_responsavel_email: operadorResponsavel,
      criado_por_nome: nomeOperadorPorEmail(email),
      criado_por_email: email,
      confirmado_por_email: email,
      confirmado_em: agora,
    })
    .select()
    .single();

  if (error) return { ok: false, erro: error.message };

  const parcelas = dados.parcelas.map((p) => ({
    acordo_id: acordo.id,
    numero: p.numero,
    valor: paraNumero(p.valor),
    honorarios: p.honorarios != null ? paraNumero(p.honorarios) : null,
    vencimento: paraDataISO(p.vencimento) || p.vencimento,
    status: p.status,
  }));

  const { error: e2 } = await supabase.from("parcelas").insert(parcelas);
  if (e2) {
    return {
      ok: false, acordo, erro: "Acordo criado, mas as parcelas não foram geradas: " + e2.message,
    };
  }

  if (dados.temEntrada && entrada > 0) {
    const dataEntrada = paraDataISO(dados.dataEntrada) || hojeISO();
    const honEntrada = paraNumero(dados.honorariosEntrada);
    const paga = Boolean(dados.entradaPaga);

    const { data: parcelaEntrada, error: erroEntrada } = await supabase
      .from("parcelas")
      .insert({
        acordo_id: acordo.id,
        numero: 0,
        valor: entrada,
        honorarios: honEntrada || 0,
        vencimento: dataEntrada,
        status: paga ? "PAGO" : "A_VENCER",
        pago_em: paga ? dataEntrada : null,
        confirmado_por_email: paga ? email : null,
        // A tela identifica a entrada por este campo. Sem ele, o rateio de
        // honorário e o "parcelado restante" tratam a entrada como parcela comum.
        is_entrada: true,
      })
      .select()
      .single();

    if (erroEntrada) {
      avisos.push(
        "A parcela da ENTRADA não foi gerada: " + erroEntrada.message +
        " -- lance a entrada na mão, senão esse valor não será cobrado."
      );
    } else if (paga) {
      const { error: erroBaixa } = await supabase.from("baixas_pagamento").insert({
        aluno_id: String(aluno.id),
        aluno_nome: aluno.nome || null,
        aluno_cpf: aluno.cpf || null,
        valor_pago: entrada,
        honorarios_recebidos: honEntrada || 0,
        status_baixa: "REALIZADA",
        responsavel_baixa_nome: nomeOperadorPorEmail(operadorResponsavel),
        responsavel_baixa_email: operadorResponsavel,
        baixado_por_email: email,
        data_pagamento: dataEntrada,
        parcela_id: parcelaEntrada?.id || null,
        acordo_id: acordo.id,
      });
      if (erroBaixa) {
        avisos.push(
          "A entrada ficou como parcela paga, mas a baixa não foi registrada: " +
          erroBaixa.message + " -- ela não vai aparecer no valor baixado do dia."
        );
      }
    }
  }

  return { ok: true, acordo, avisos };
}
