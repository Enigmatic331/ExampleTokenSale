interface token {
    function transfer(address receiver, uint amount);
}

library SafeMath {
  function mul(uint256 a, uint256 b) internal constant returns (uint256) {
    uint256 c = a * b;
    assert(a == 0 || c / a == b);
    return c;
  }

  function div(uint256 a, uint256 b) internal constant returns (uint256) {
    // assert(b > 0); // Solidity automatically throws when dividing by 0
    uint256 c = a / b;
    // assert(a == b * c + a % b); // There is no case in which this doesn't hold
    return c;
  }

  function sub(uint256 a, uint256 b) internal constant returns (uint256) {
    assert(b <= a);
    return a - b;
  }

  function add(uint256 a, uint256 b) internal constant returns (uint256) {
    uint256 c = a + b;
    assert(c >= a);
    return c;
  }
}

//define function for ownership
//sets owner to msg.sender during contract initialisation
contract owned {
    address public owner;

    function owned() {
        owner = msg.sender;
    }

    modifier onlyOwner {
        require(msg.sender == owner);
        _;
    }

    function transferOwnership(address newOwner) onlyOwner {
        owner = newOwner;
    }
}



contract Crowdsale is owned {
    //Public cap, change this value to change the cap for non-whitelisted addresses
    uint public constant PUBLIC_CAP = 0.2 ether;

    mapping(address => uint256) public balanceOf;
    mapping (address => bool) public whiteListNoMinContribution;
    address public beneficiary;
    uint public fundingGoal;
    uint public amountRaised;
    uint public deadline;
    uint public price;
    TestToken public tokenReward;
    
    bool fundingGoalReached = false;
    bool crowdsaleClosed = false;

    event GoalReached(address beneficiary, uint amountRaised);
    event FundTransfer(address backer, uint amount, bool isContribution);

    using SafeMath for uint;

    
    //setup the crowdsale terms
    function Crowdsale() {
        beneficiary = //enter beneficiary account here!!!
        fundingGoal = 1 ether;
        deadline = now.add(6000 minutes);
        price = 0.001 ether;
        tokenReward = new TestToken();
    }


    //Fallback function
    function () payable {
        require(!crowdsaleClosed);
        uint amount = msg.value;
        bool whitelisted = whiteListNoMinContribution[msg.sender];
        
        if (whitelisted == true) {
            tokenReward.transfer(msg.sender, amount.div(price));

            FundTransfer(msg.sender, amount, true);
            balanceOf[msg.sender] = balanceOf[msg.sender].add(amount);
        } else {
            //two scenarios to be dealt with for non-whitelisted addresses
            if (amount > PUBLIC_CAP || balanceOf[msg.sender].add(amount) > PUBLIC_CAP) {
                uint remainder;
                uint toReturn;

                if (amount > PUBLIC_CAP) {
                    //get remainder, double check to see if there is an existing balance
                    remainder = amount.sub(PUBLIC_CAP);
                    remainder = remainder.sub(balanceOf[msg.sender]);
                } else {
                    //subtract balanceOf[msg.sender] from PUBLIC_CAP and that's our remainder allotment
                    remainder = PUBLIC_CAP.sub(balanceOf[msg.sender]);
                }
                
                toReturn = amount.sub(remainder);

                require(remainder > 0);
                tokenReward.transfer(msg.sender, remainder.div(price));
                FundTransfer(msg.sender, 2, true);
                balanceOf[msg.sender] = balanceOf[msg.sender].add(remainder);

                //update amount
                amount = remainder;

                //transfer back what's left
                msg.sender.transfer(toReturn);
            } else {
                tokenReward.transfer(msg.sender, amount.div(price));
                FundTransfer(msg.sender, amount, true);
                balanceOf[msg.sender] = balanceOf[msg.sender].add(amount);
            }
        }
        amountRaised = amountRaised.add(amount);
    }




    modifier afterDeadline() {
        if (now >= deadline)
            _;
        }


    //Whitelist function
    //Note: An additional function to remove whitelist could be added as well
    function addToWhiteList(address sender) onlyOwner returns (bool) {
        whiteListNoMinContribution[sender] = true;
        return whiteListNoMinContribution[sender];
    }


    /**
     * Check if goal was reached
     *
     * Checks if the goal or time limit has been reached and ends the campaign
     */
    function checkGoalReached() afterDeadline {
        if (amountRaised >= fundingGoal) {
            fundingGoalReached = true;
            GoalReached(beneficiary, amountRaised);
        }
        crowdsaleClosed = true;
    }


    /**
     * Withdraw the funds
     *
     * Checks to see if goal or time limit has been reached, and if so, and the funding goal was reached,
     * sends the entire amount to the beneficiary. If goal was not reached, each contributor can withdraw
     * the amount they contributed.
     */
    function safeWithdrawal() afterDeadline {
        if (!fundingGoalReached) {
            uint amount = balanceOf[msg.sender];
            balanceOf[msg.sender] = 0;
            if (amount > 0) {
                if (msg.sender.send(amount)) {
                    FundTransfer(msg.sender, amount, false);
                } else {
                    balanceOf[msg.sender] = amount;
                }
            }
        }

        if (fundingGoalReached && beneficiary == msg.sender) {
            if (beneficiary.send(amountRaised)) {
                FundTransfer(beneficiary, amountRaised, false);
            } else {
                //If we fail to send the funds to beneficiary, unlock funders balance
                fundingGoalReached = false;
            }
        }
    }
}


contract Token {
    function totalSupply() constant returns (uint256 supply) {}
    function balanceOf(address _owner) constant returns (uint256 balance) {}
    function transfer(address _to, uint256 _value) returns (bool success) {}
    function transferFrom(address _from, address _to, uint256 _value) returns (bool success) {}
    function approve(address _spender, uint256 _value) returns (bool success) {}
    function allowance(address _owner, address _spender) constant returns (uint256 remaining) {}

    event Transfer(address indexed _from, address indexed _to, uint256 _value);
    event Approval(address indexed _owner, address indexed _spender, uint256 _value);
}



contract StandardToken is Token {
    using SafeMath for uint256;

    function transfer(address _to, uint256 _value) returns (bool) {
        balances[msg.sender] = balances[msg.sender].sub(_value);
        balances[_to] = balances[_to].add(_value);
        Transfer(msg.sender, _to, _value);
        return true;
    }

    function transferFrom(address _from, address _to, uint256 _value) returns (bool) {
        var _allowance = allowed[_from][msg.sender];

        balances[_from] = balances[_from].sub(_value);
        balances[_to] = balances[_to].add(_value);
        allowed[_from][msg.sender] = _allowance.sub(_value);
        Transfer(_from, _to, _value);
        return true;
    }


    function balanceOf(address _owner) constant returns (uint256 balance) {
        return balances[_owner];
    }

    function approve(address _spender, uint256 _value) returns (bool success) {
        allowed[msg.sender][_spender] = _value;
        Approval(msg.sender, _spender, _value);
        return true;
    }

    function allowance(address _owner, address _spender) constant returns (uint256 remaining) {
      return allowed[_owner][_spender];
    }

    mapping (address => uint256) balances;
    mapping (address => mapping (address => uint256)) allowed;
    uint256 public totalSupply;
}


//token contract
contract TestToken is StandardToken {

    function () {
        //if ether is sent, send it back
        revert();
    }

    /* Public variables of the token */
    string public name;                   
    uint8 public decimals;                
    string public symbol;                 


    function TestToken() {
        totalSupply = 100000000;                        
        balances[msg.sender] = totalSupply;             
        name = //enter name here!!!!!                         
        decimals = 0; 
        symbol = "TSE";
    }
}
