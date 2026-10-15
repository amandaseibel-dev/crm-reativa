// Guardas do aviso na hora do retorno dentro do PainelCarteira (leitura do
// codigo-fonte; o componente e grande demais para montar em teste -- mesmo
// motivo de PainelCarteira.alertaD2.test.js e PainelCarteira.meuDia.test.js).
//
// O que estas checagens protegem:
//  1. a gestao olhando a carteira de outra pessoa nao recebe o aviso dela;
//  2. nada abre por cima de uma ficha aberta, para nao cortar um atendimento;
//  3. o aviso nao se repete sozinho -- quem traz de volta e o operador;
//  4. o relogio da tela anda sozinho (sem isso o aviso so apareceria no
//     proximo carregamento da pagina).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(AQUI, "PainelCarteira.jsx"), "utf8");

describe("PainelCarteira: aviso na hora do retorno", () => {
  it("decide o aviso pela regra pura, nao por conta propria", () => {
    expect(SRC).toMatch(/retornoParaAvisar\(retornosDaSemana, \{ hoje: hojeLocalBR\(\), horaAgora, silenciados \}\)/);
    expect(SRC).toMatch(/<AvisoRetornoNaHora/);
  });

  it("gestao e ficha aberta barram o aviso", () => {
    const bloco = SRC.slice(SRC.indexOf("const retornoDaHora = useMemo"), SRC.indexOf("const retornoDaHora = useMemo") + 450);
    expect(bloco).toMatch(/if \(veTudo\) return null;/);
    expect(bloco).toMatch(/if \(alunoModal\) return null;/);
  });

  it("abrir a ficha e 'ja falei' calam o resto do dia; lembrar depois volta na hora nova", () => {
    const bloco = SRC.slice(SRC.indexOf("<AvisoRetornoNaHora"), SRC.indexOf("<AvisoRetornoNaHora") + 900);
    expect(bloco).toMatch(/onAbrirFicha=\{\(r\) => \{[\s\S]*silenciarRetorno\(r\.id, ""\)/);
    expect(bloco).toMatch(/onLembrarDepois=\{\(r, minutos\) => silenciarRetorno\(r\.id, somarMinutos\(horaAgora, minutos\)\)\}/);
    expect(bloco).toMatch(/onMarcarFeito=\{\(r\) => \{[\s\S]*confirmarRetornoAgenda\(r\.id, true\)/);
  });

  it("o relogio da tela anda sozinho e e limpo ao sair", () => {
    const bloco = SRC.slice(SRC.indexOf("setInterval(() => setHoraAgora"), SRC.indexOf("setInterval(() => setHoraAgora") + 200);
    expect(bloco).toMatch(/30000/);
    expect(bloco).toMatch(/clearInterval/);
  });

  it("a memoria do navegador e lida no inicializador do estado, nao num efeito", () => {
    // Por posicao, nao por regex atravessando o arquivo: um `[\s\S]{0,300}`
    // aqui casaria de qualquer useEffect ate o setSilenciados de
    // `silenciarRetorno`, e o teste passaria a acusar o que nao existe.
    const inicializador = SRC.indexOf("const [silenciados, setSilenciados] = useState(() => {");
    const leitura = SRC.indexOf("localStorage.getItem(chaveSilenciados(hojeLocalBR()))");
    expect(inicializador).toBeGreaterThan(-1);
    expect(leitura).toBeGreaterThan(inicializador);
    expect(leitura - inicializador).toBeLessThan(400);
  });

  it("o campo de hora da tabulacao diz o que faz", () => {
    const bloco = SRC.slice(SRC.indexOf("Agendar retorno</label>"), SRC.indexOf("Agendar retorno</label>") + 1600);
    expect(bloco).toMatch(/Hora — avisa você/);
    expect(bloco).toMatch(/type="time"/);
  });
});
